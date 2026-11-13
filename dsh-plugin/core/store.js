/** The rule service owns this database and its event subscription. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const parse = row => row && JSON.parse(row.body);
const json = JSON.stringify;
const timestamp = () => new Date().toISOString();
const triggerKey = rule => !rule.enabled ? null : rule.trigger.type === 'state'
  ? 'state:' + rule.trigger.entity_id : 'event:' + rule.trigger.event_type;

export class RuleStore {
  constructor(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !path.normalize(directory).split(path.sep).includes('.local')) throw new Error('HA_PRIVATE_STATE_PATH_REQUIRED');
    this.directory = directory;
    this.file = path.join(directory, 'rules.sqlite');
    this.legacyFile = path.join(directory, 'rules.private.json');
    this.ownerFile = path.join(directory, 'owner.sqlite');
    this.legacyLock = path.join(directory, 'owner.lock');
  }

  async open() {
    if (this.ownerDb || this.opening) throw new Error('HA_STORE_ALREADY_OWNED');
    this.opening = true;
    this.closing = null;
    try {
      await this.takeOwnership();
      await this.privateFile(this.file);
      this.db = new DatabaseSync(this.file);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw new Error('HA_STORE_INVALID');
      if (version === 0) await this.migrate();
      this.transaction(() => {
        const interrupted = this.statement("SELECT seq,body FROM runs WHERE status='running'").all();
        for (const {seq, body} of interrupted) {
          const run = {...JSON.parse(body), status: 'interrupted', finished_at: timestamp()};
          this.statement('UPDATE runs SET status=?, body=? WHERE seq=?').run(run.status, json(run), seq);
        }
        for (const {id, body} of this.statement("SELECT id,body FROM controls WHERE status='dispatching'").all())
          this.writeControl({...JSON.parse(body), operation_id: id, status: 'uncertain',
            reason: 'core_restarted_during_dispatch', finished_at: timestamp()});
      });
    } catch (error) {
      await this.close();
      throw error;
    } finally { this.opening = false; }
  }

  async privateFile(file) {
    const handle = await fs.open(file, 'a', 0o600);
    try { await handle.chmod(0o600); } finally { await handle.close(); }
  }

  async takeOwnership() {
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    // Preserve the old runtime's active ownership during upgrades.
    try {
      const {pid} = JSON.parse(await fs.readFile(this.legacyLock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('HA_STORE_LOCK_INVALID');
      try { process.kill(pid, 0); throw new Error('HA_STORE_ALREADY_OWNED'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }

    await this.privateFile(this.ownerFile);
    this.ownerDb = new DatabaseSync(this.ownerFile);
    try { this.ownerDb.exec('BEGIN EXCLUSIVE'); }
    catch (error) {
      if (error.errcode === 5) throw new Error('HA_STORE_ALREADY_OWNED');
      throw error;
    }
  }

  async migrate() {
    let legacy;
    try { legacy = JSON.parse(await fs.readFile(this.legacyFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; legacy = {version: 1, rules: [], runs: [], gaps: []}; }
    if (!legacy || legacy.version !== 1
      || !['rules', 'runs', 'gaps'].every(key => Array.isArray(legacy[key]))
      || legacy.cooldowns !== undefined && (!legacy.cooldowns || typeof legacy.cooldowns !== 'object' || Array.isArray(legacy.cooldowns)))
      throw new Error('HA_STORE_INVALID');
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE rules (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, trigger TEXT, body TEXT);
        CREATE INDEX rules_by_trigger ON rules(trigger) WHERE trigger IS NOT NULL;
        CREATE TABLE rule_versions (id TEXT, revision INTEGER, body TEXT NOT NULL, PRIMARY KEY (id, revision));
        CREATE TABLE drafts (id TEXT PRIMARY KEY, published_revision INTEGER, body TEXT NOT NULL);
        CREATE TABLE runs (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, dedupe TEXT NOT NULL UNIQUE,
          rule_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX runs_by_rule ON runs(rule_id, seq);
        CREATE INDEX runs_in_flight ON runs(status) WHERE status='running';
        CREATE TABLE controls (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX controls_in_flight ON controls(status) WHERE status='dispatching';
        CREATE TABLE cooldowns (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
        CREATE TABLE gaps (seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE native (id INTEGER PRIMARY KEY CHECK (id=1), body TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      // The old snapshot retains executed definitions as well as current rules.
      // When an ID was reused, its current definition is the best version anchor.
      const current = new Map(legacy.rules.map(rule => [rule.id, rule]));
      for (const rule of current.values()) this.writeVersion(rule.id, rule.revision, 'import', rule, undefined, rule.updated_at);
      for (const run of legacy.runs) {
        this.insertRun(run);
        const rule = run.request?.rule;
        // The old format could reuse IDs after deletion. Those definitions remain on their runs.
        if (!rule || rule.revision >= (current.get(rule.id)?.revision ?? Infinity)) continue;
        this.statement('INSERT OR IGNORE INTO rule_versions VALUES (?,?,?)').run(rule.id, rule.revision,
          json({id: rule.id, revision: rule.revision, change: 'import', at: rule.updated_at ?? timestamp(), rule}));
      }
      // Retain deleted identities found in old run history so their revisions cannot be reused.
      this.db.exec(`INSERT OR IGNORE INTO rules (id,revision)
        SELECT id,MAX(revision) FROM rule_versions GROUP BY id`);
      for (const [id, at] of Object.entries(legacy.cooldowns ?? {}))
        this.statement('INSERT INTO cooldowns VALUES (?,?)').run(id, at);
      for (const gap of legacy.gaps) this.statement('INSERT INTO gaps(body) VALUES (?)').run(json(gap));
      this.statement('INSERT INTO native VALUES (1,?)').run(json({
        native_automations: legacy.native_automations ?? [], native_pending: legacy.native_pending ?? {},
      }));
    });
  }

  statement(sql) {
    if (!this.statements) this.statements = new Map();
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, statement = this.db.prepare(sql));
    return statement;
  }

  transaction(work) {
    if (!this.db || this.closing) throw new Error('HA_STORE_CLOSED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  rules(key) {
    const rows = key === undefined
      ? this.statement('SELECT body FROM rules WHERE body IS NOT NULL ORDER BY rowid').all()
      : this.statement('SELECT body FROM rules WHERE trigger=? ORDER BY rowid').all(key);
    return rows.map(parse);
  }
  rule(id) { return parse(this.statement('SELECT body FROM rules WHERE id=? AND body IS NOT NULL').get(id)); }
  revision(id) { return this.statement('SELECT revision FROM rules WHERE id=?').get(id)?.revision ?? 0; }

  writeVersion(id, revision, change, rule, origin, at = timestamp(), details = {}) {
    this.statement(`INSERT INTO rules VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE
      SET revision=excluded.revision,trigger=excluded.trigger,body=excluded.body`)
      .run(id, revision, rule ? triggerKey(rule) : null, rule ? json(rule) : null);
    this.statement('INSERT INTO rule_versions VALUES (?,?,?)').run(id, revision,
      json({id, revision, change, at, origin, rule, ...details}));
  }

  saveRule(rule, expectedRevision, {signal, origin, change = 'put', targetRevision, draftId} = {}) {
    return this.transaction(() => {
      signal?.throwIfAborted();
      if (draftId) {
        const published = this.draft(draftId)?.published_revision;
        if (published) {
          const prior = this.version(rule.id, published).rule;
          if (prior.enabled !== rule.enabled) throw new Error('HA_DRAFT_ALREADY_PUBLISHED');
          return {rule: prior, committed: false};
        }
      }
      if (this.revision(rule.id) !== expectedRevision) throw new Error('HA_RULE_REVISION_CONFLICT');
      if (!this.rule(rule.id) && this.statement('SELECT COUNT(*) AS n FROM rules WHERE body IS NOT NULL').get().n >= 256)
        throw new Error('HA_RULE_LIMIT');
      const at = timestamp(), next = {...rule, revision: expectedRevision + 1, updated_at: at};
      this.writeVersion(rule.id, next.revision, change, next, origin, at, {target_revision: targetRevision, draft_id: draftId});
      if (draftId) this.statement('UPDATE drafts SET published_revision=? WHERE id=?').run(next.revision, draftId);
      return {rule: next, committed: true};
    });
  }

  removeRule(id, expectedRevision, {signal, origin} = {}) {
    return this.transaction(() => {
      signal?.throwIfAborted();
      const rule = this.rule(id);
      if (!rule || rule.revision !== expectedRevision) throw new Error('HA_RULE_REVISION_CONFLICT');
      this.writeVersion(id, expectedRevision + 1, 'delete', undefined, origin);
      this.statement('DELETE FROM cooldowns WHERE id=?').run(id);
      return {id, deleted: true};
    });
  }

  version(id, revision) {
    return parse(this.statement('SELECT body FROM rule_versions WHERE id=? AND revision=?').get(id, revision));
  }
  history(id, before, limit) {
    return this.statement(`SELECT body FROM rule_versions WHERE id=? AND revision < ?
      ORDER BY revision DESC LIMIT ?`).all(id, before, limit).map(parse);
  }
  draft(id) {
    const row = this.statement('SELECT body,published_revision FROM drafts WHERE id=?').get(id);
    return row && {...parse(row), published_revision: row.published_revision};
  }
  saveDraft(draft, signal) {
    return this.transaction(() => {
      signal?.throwIfAborted();
      const existing = this.draft(draft.id);
      if (existing) return existing;
      if (this.revision(draft.rule.id) !== draft.base_revision) throw new Error('HA_RULE_REVISION_CONFLICT');
      this.statement('INSERT INTO drafts (id,body) VALUES (?,?)').run(draft.id, json(draft));
      return this.draft(draft.id);
    });
  }

  recordDraftCheck(id, result, signal) {
    return this.transaction(() => {
      signal?.throwIfAborted();
      const {published_revision, ...draft} = this.draft(id);
      draft.checks = [...(draft.checks ?? []), result].slice(-8);
      this.statement('UPDATE drafts SET body=? WHERE id=?').run(json(draft), id);
    });
  }
  seenRun(key) { return !!this.statement('SELECT 1 FROM runs WHERE dedupe=?').get(key); }
  insertRun(run) {
    return this.statement('INSERT INTO runs (id,dedupe,rule_id,status,body) VALUES (?,?,?,?,?)')
      .run(run.id, run.key, run.rule_id, run.status, json(run));
  }
  claimRun(run, {cooldown, now, signal}) {
    return this.transaction(() => {
      const rule = this.rule(run.rule_id);
      if (!rule?.enabled || rule.revision !== run.revision || (signal.aborted && run.status === 'running')
        || this.seenRun(run.key)) return null;
      const last = this.statement('SELECT at FROM cooldowns WHERE id=?').get(run.rule_id)?.at;
      if (run.status === 'running' && last !== undefined && now - last < cooldown) {
        run = {...run, status: 'skipped', error: 'HA_RULE_COOLDOWN', finished_at: timestamp()};
      }
      if (run.status === 'running') this.statement(`INSERT INTO cooldowns VALUES (?,?)
        ON CONFLICT(id) DO UPDATE SET at=excluded.at`).run(run.rule_id, now);
      this.insertRun(run);
      return run;
    });
  }
  updateRun(id, change) {
    return this.transaction(() => {
      const run = this.run(id);
      if (!run) throw new Error('HA_RUN_NOT_FOUND');
      Object.assign(run, change);
      delete run.cursor;
      this.statement('UPDATE runs SET status=?,body=? WHERE id=?').run(run.status, json(run), id);
    });
  }
  run(id) {
    const row = this.statement('SELECT seq,body FROM runs WHERE id=?').get(id);
    return row && {...parse(row), cursor: row.seq};
  }
  runs({id, before = Number.MAX_SAFE_INTEGER, limit = 20, includeSkipped = true} = {}) {
    const filters = ['seq<?'];
    const parameters = [before];
    if (id !== undefined) { filters.push('rule_id=?'); parameters.push(id); }
    if (!includeSkipped) filters.push("status<>'skipped'");
    return this.statement(`SELECT seq,body FROM runs WHERE ${filters.join(' AND ')} ORDER BY seq DESC LIMIT ?`)
      .all(...parameters, limit).map(row => ({...parse(row), cursor: row.seq}));
  }
  control(id) {
    return parse(this.statement('SELECT body FROM controls WHERE id=?').get(id));
  }
  claimControl(intent, signal) {
    return this.transaction(() => {
      signal?.throwIfAborted();
      const existing = this.control(intent.operation_id);
      if (existing) return existing;
      this.statement('INSERT INTO controls (id,status,body) VALUES (?,?,?)')
        .run(intent.operation_id, intent.status, json(intent));
      return null;
    });
  }
  writeControl(receipt) {
    this.statement('UPDATE controls SET status=?,body=? WHERE id=?')
      .run(receipt.status, json(receipt), receipt.operation_id);
  }

  recordGap(details) {
    return this.transaction(() => {
      this.statement('INSERT INTO gaps(body) VALUES (?)').run(json(details));
      this.db.exec('DELETE FROM gaps WHERE seq <= (SELECT MAX(seq)-100 FROM gaps)');
    });
  }
  gaps(limit = 10) { return this.statement('SELECT body FROM gaps ORDER BY seq DESC LIMIT ?').all(limit).map(parse).reverse(); }

  nativeSnapshot() { return parse(this.statement('SELECT body FROM native WHERE id=1').get()); }
  async transactNative(update) {
    return this.transaction(() => {
      const next = this.nativeSnapshot(), result = update(next);
      this.statement('UPDATE native SET body=? WHERE id=1').run(json(next));
      return result;
    });
  }

  snapshot() {
    return {rules: this.rules(), runs: this.runs({limit: 512, includeSkipped: false}).reverse(),
      gaps: this.gaps(100), ...this.nativeSnapshot()};
  }

  async close() {
    this.closing = true;
    this.statements?.clear();
    try { this.db?.close(); } finally {
      this.db = null;
      this.ownerDb?.close();
      this.ownerDb = null;
    }
  }
}
