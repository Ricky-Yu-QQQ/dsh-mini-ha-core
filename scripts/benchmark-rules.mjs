import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const old = process.argv[2];
const current = new URL('../dsh-plugin/core/', import.meta.url);
const variants = old
  ? [['legacy-json', pathToFileURL(path.resolve(old) + '/'), true], ['sqlite', current, false]]
  : [['sqlite', current, false]];
const event = (id, sequence) => ({event_type: 'state_changed', time_fired: new Date().toISOString(),
  context: {id: 'sample-' + sequence}, data: {entity_id: id, old_state: {state: 'off'}, new_state: {state: 'on'}}});
const stats = times => {
  times.sort((a, b) => a - b);
  const pct = p => Number(times[Math.ceil(times.length * p) - 1].toFixed(4));
  return {count: times.length, p50_ms: pct(0.5), p95_ms: pct(0.95)};
};
const root = await mkdtemp(path.join(tmpdir(), 'mini-ha-bench-'));
try {
  for (const [name, url, legacy] of variants) {
    const {RuleStore} = await import(new URL('store.js', url));
    const {RuleEngine} = await import(new URL('engine.js', url));
    const rules = Array.from({length: 256}, (_, n) => ({
      id: 'rule-' + n, revision: 1, updated_at: new Date().toISOString(), name: 'Benchmark ' + n, enabled: true,
      trigger: {type: 'state', entity_id: 'binary_sensor.sample_' + n, from: 'off', to: 'on'},
      conditions: [], actions: [{type: 'control', entity_id: 'light.bench', action: 'turn_on'}], cooldown_ms: 1000,
    }));
    const target = 'binary_sensor.sample_0';
    const store = new RuleStore(path.join(root, name, '.local'));
    await mkdir(store.directory, {recursive: true, mode: 0o700});
    const runs = Array.from({length: 256}, (_, n) => ({
      id: 'historical-' + n, key: 'historical-' + n, rule_id: rules[n].id, revision: 1, status: 'completed',
      request: {rule: rules[n], event: event(rules[n].trigger.entity_id, n)}, results: [],
    }));
    await writeFile(path.join(store.directory, 'rules.private.json'), JSON.stringify({version: 1, rules, runs, gaps: [], cooldowns: {}}),
      {mode: 0o600});
    await store.open();
    const client = {ready: true, eventTypes: ['state_changed']};
    const controls = {entities: new Map([[target, {entity_id: target}],
      ['light.bench', {entity_id: 'light.bench', control_allowed: true}]]),
      async get() { return {state: 'on', attributes: {}}; }, async control() { return {status: 'confirmed'}; }};
    const engine = new RuleEngine({store, client, controls, settings: {}});
    const match = [], run = [];
    try {
      for (let i = 0; i < 500; i++) {
        const input = event('binary_sensor.unmatched', i);
        controls.entities.set(input.data.entity_id, {});
        const start = performance.now();
        engine.accept(input, 1);
        if (i >= 20) match.push(performance.now() - start);
      }
      for (let i = 0; i < 60; i++) {
        if (legacy) await store.transact(data => { delete data.cooldowns[rules[0].id]; });
        else store.db.prepare('DELETE FROM cooldowns WHERE id=?').run(rules[0].id);
        const input = event(target, i);
        const start = performance.now();
        engine.accept(input, 1);
        await engine.tail;
        if (i >= 10) run.push(performance.now() - start);
      }
      if (engine.health.last_error || store.snapshot().runs.filter(row => row.rule_id === rules[0].id).length !== 61)
        throw new Error('Missing benchmark runs');
      console.log(JSON.stringify({name, unmatched_event: stats(match), one_action_with_receipt: stats(run)}));
    } finally { await engine.close(); await store.close(); }
  }
} finally { await rm(root, {recursive: true, force: true}); }
