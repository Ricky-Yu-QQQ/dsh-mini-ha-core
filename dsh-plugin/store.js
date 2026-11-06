/** One owner, serialized transactions, private atomic snapshots. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export class RuleStore {
  constructor(directory) {
    if (!path.isAbsolute(directory) || !directory.split(path.sep).includes('.local')) throw new Error('HA_PRIVATE_STATE_PATH_REQUIRED');
    this.directory = directory;
    this.file = path.join(directory, 'rules.private.json');
    this.lock = path.join(directory, 'owner.lock');
    this.tail = Promise.resolve();
    this.closing = null;
    this.data = {version: 1, rules: [], runs: [], gaps: [], cooldowns: {}};
  }
  async open() {
    if (this.closing) await this.closing;
    if (this.locked) throw new Error('HA_STORE_ALREADY_OWNED');
    this.closing = null;
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    this.owner = JSON.stringify({pid: process.pid, nonce: randomUUID()});
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(this.lock, 'wx', 0o600);
        try { await handle.writeFile(this.owner); } finally { await handle.close(); }
        this.locked = true; break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const original = await fs.readFile(this.lock, 'utf8');
        const owner = JSON.parse(original);
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('HA_STORE_LOCK_INVALID');
        try { process.kill(owner.pid, 0); throw new Error('HA_STORE_ALREADY_OWNED'); }
        catch (check) { if (check.code !== 'ESRCH') throw check; }
        if (await fs.readFile(this.lock, 'utf8') !== original) throw new Error('HA_STORE_OWNER_CHANGED');
        await fs.unlink(this.lock);
      }
    }
    if (!this.locked) throw new Error('HA_STORE_LOCK_FAILED');
    try {
      try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (this.data.version !== 1 || !['rules', 'runs', 'gaps'].every(key => Array.isArray(this.data[key])))
        throw new Error('HA_STORE_INVALID');
      this.data.cooldowns ??= {};
      if (!this.data.cooldowns || typeof this.data.cooldowns !== 'object' || Array.isArray(this.data.cooldowns))
        throw new Error('HA_STORE_INVALID');
      // A process crash can leave side effects uncertain. Preserve the claim; never replay it.
      await this.transact(data => {
        for (const run of data.runs) if (run.status === 'running') {
          run.status = 'interrupted'; run.finished_at = new Date().toISOString();
        }
      });
    } catch (error) { await this.close(); throw error; }
  }
  snapshot() { return structuredClone(this.data); }
  transact(update) {
    if (!this.locked || this.closing) return Promise.reject(new Error('HA_STORE_CLOSED'));
    const work = this.tail.then(async () => {
      if (!this.locked) throw new Error('HA_STORE_CLOSED');
      const next = this.snapshot(), result = update(next);
      next.runs = next.runs.slice(-512); next.gaps = next.gaps.slice(-100);
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(next, null, 2) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, this.file);
        // Rename committed even if the subsequent directory fsync reports an error.
        this.data = next;
        const directory = await fs.open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await fs.rm(temporary, {force: true}); }
      return structuredClone(result);
    });
    this.tail = work.catch(() => {});
    return work;
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.tail;
      if (this.locked && await fs.readFile(this.lock, 'utf8') === this.owner) await fs.unlink(this.lock);
      this.locked = false;
    })();
    return this.closing;
  }
}
