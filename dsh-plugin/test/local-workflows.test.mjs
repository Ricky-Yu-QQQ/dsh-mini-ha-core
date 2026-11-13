import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {HomeCore} from '../core/index.js';

const example = JSON.parse(await fs.readFile(new URL('../simulated.example.json', import.meta.url), 'utf8'));
const rule = {
  id: 'presence-light', name: '有人且暗时开灯', enabled: false,
  trigger: {type: 'state', entity_id: 'binary_sensor.living_presence', from: 'off', to: 'on'},
  conditions: [{entity_id: 'sensor.living_illuminance', below: 30}],
  actions: [{type: 'control', entity_id: 'light.living', action: 'turn_on'}],
};

async function fixture(t, setup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-ha-core-'));
  const settings = {...example, state: path.join(root, '.local')};
  const cores = [];
  t.after(async () => {
    for (const core of cores.reverse()) await core.close();
    await fs.rm(root, {recursive: true, force: true});
  });
  await setup?.(settings);
  return async () => {
    const core = new HomeCore(settings);
    cores.push(core);
    await core.start();
    return core;
  };
}

test('Core runs an AI-authored device rule after restart and retains version and condition evidence', async t => {
  const open = await fixture(t);
  const first = await open();
  const origin = {session_id: 'design-session', call_id: 'draft-1'};
  const draft = first.engine.saveDraft(rule, 0, {origin});
  assert.equal(first.engine.saveDraft(rule, 0, {origin}).id, draft.id);
  assert.deepEqual(first.engine.list(), []);
  const event = first.client.setState('binary_sensor.living_presence', 'on');
  const states = [
    {entity_id: 'binary_sensor.living_presence', state: 'on'},
    {entity_id: 'sensor.living_illuminance', state: '5'},
  ];
  const testRun = await first.engine.testDraft(draft.id, event, states);
  assert.equal(testRun.matched, true);
  assert.equal(testRun.executes, false);
  assert.deepEqual(testRun.actions, rule.actions);
  assert.equal((await first.engine.testDraft(draft.id, event,
    [states[0], {...states[1], state: '70'}])).reason, 'condition_false');
  assert.equal(first.client.calls.length, 0);
  assert.throws(() => first.engine.saveDraft({...rule, actions: [{type: 'agent', prompt: 'launch'}]}, 0), /HA_DRAFT_ACTION_DENIED/);
  const publishOrigin = {session_id: 'design-session', call_id: 'publish-1'};
  const active = await first.engine.publishDraft(draft.id, true, {origin: publishOrigin});
  assert.equal(active.revision, 1);
  assert.equal((await first.engine.publishDraft(draft.id, true)).revision, 1);
  await assert.rejects(first.engine.publishDraft(draft.id, false), /HA_DRAFT_ALREADY_PUBLISHED/);
  assert.equal(first.client.calls.length, 0);
  await first.close();

  const second = await open();
  assert.equal(second.store.draft(draft.id).checks.length, 2);
  assert.deepEqual(second.store.draft(draft.id).origin, origin);
  assert.equal(second.store.draft(draft.id).published_revision, 1);
  assert.deepEqual(second.store.version(rule.id, 1).origin, publishOrigin);
  second.client.setState('sensor.living_illuminance', '70');
  second.client.setState('binary_sensor.living_presence', 'on');
  await second.engine.tail;
  assert.equal(second.client.calls.length, 0);
  const [skipped] = second.store.runs({id: rule.id});
  assert.equal(skipped.status, 'skipped');
  assert.deepEqual(skipped.evaluation.conditions, [{entity_id: 'sensor.living_illuminance', value: '70', passed: false}]);

  second.client.setState('binary_sensor.living_presence', 'off');
  second.client.setState('sensor.living_illuminance', '5');
  const trigger = second.client.setState('binary_sensor.living_presence', 'on');
  await second.engine.tail;
  second.engine.accept(trigger, second.client.generation);
  await second.engine.tail;
  assert.equal(second.client.calls.length, 1);
  const [completed] = second.store.runs({id: rule.id});
  assert.equal(completed.revision, active.revision);
  assert.equal(completed.results[0].result.status, 'confirmed');
  assert.equal(completed.results[0].result.state.state, 'on');
  assert.ok(completed.results[0].elapsed_ms >= 0);
  assert.deepEqual(second.store.run(completed.id).request.event, trigger);
  assert.equal(second.store.runs({id: rule.id, before: completed.cursor})[0].id, skipped.id);

  const stale = second.engine.saveDraft({...rule, name: '准备更新'}, 1);
  await second.engine.setEnabled(rule.id, 1, false);
  await assert.rejects(second.engine.publishDraft(stale.id, true), /HA_RULE_REVISION_CONFLICT/);
  const restored = await second.engine.rollback(rule.id, 2, 1);
  assert.equal(restored.revision, 3);
  assert.equal(restored.enabled, false);
  await second.engine.remove(rule.id, 3);
  assert.equal(second.store.version(rule.id, 4).change, 'delete');
  assert.equal(second.store.revision(rule.id), 4);
  assert.deepEqual(second.store.history(rule.id, 4, 3).map(row => row.revision), [3, 2, 1]);
  assert.equal(second.store.run(completed.id).results[0].result.state.state, 'on');
  await assert.rejects(second.engine.put(rule, 0), /HA_RULE_REVISION_CONFLICT/);
});

test('the Core imports the legacy snapshot once, then reads and records solely in SQLite', async t => {
  const at = new Date().toISOString();
  const legacy = {version: 1, rules: [{...rule, cooldown_ms: 1000, revision: 1, updated_at: at}], runs: [],
    gaps: [{reason: 'legacy_gap'}], cooldowns: {}, native_pending: {rule: {operation: 'delete'}}};
  const open = await fixture(t, async ({state}) => {
    await fs.mkdir(state);
    await fs.writeFile(path.join(state, 'rules.private.json'), JSON.stringify(legacy));
  });
  const first = await open();
  assert.equal(first.engine.list()[0].name, rule.name);
  assert.equal(first.store.version(rule.id, 1).change, 'import');
  assert.equal(first.store.gaps()[0].reason, 'legacy_gap');
  assert.equal(first.store.nativeSnapshot().native_pending.rule.operation, 'delete');
  await first.engine.put({...rule, name: '修改后的规则'}, 1);
  const original = await fs.readFile(first.store.legacyFile, 'utf8');
  assert.deepEqual(JSON.parse(original), legacy);
  await first.close();
  const second = await open();
  assert.equal(second.engine.list()[0].name, '修改后的规则');
  assert.equal(second.store.revision(rule.id), 2);
  assert.equal(second.store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(second.store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
});

test('direct writes have immutable receipts and a lost receipt becomes uncertain on restart', async t => {
  const open = await fixture(t);
  const core = await open();
  const operation = {entity_id: 'light.living', action: 'turn_on'};
  const origin = {session_id: 'control-session', call_id: 'first'};
  const receipt = await core.control(operation, {origin});
  assert.equal(receipt.status, 'confirmed');
  assert.deepEqual(core.store.control(receipt.operation_id), receipt);
  assert.deepEqual(await core.control(operation, {origin}), receipt);
  assert.equal(core.client.calls.length, 1);
  await assert.rejects(() => core.control({...operation, action: 'turn_off'}, {origin}), /HA_CONTROL_REQUEST_CONFLICT/);

  const originalWrite = core.store.writeControl.bind(core.store);
  core.store.writeControl = () => { throw new Error('lost commit'); };
  const interrupted = {session_id: 'control-session', call_id: 'lost'};
  await assert.rejects(core.control({...operation, action: 'turn_off'}, {origin: interrupted}), /lost commit/);
  assert.equal(core.client.calls.length, 2);
  core.store.writeControl = originalWrite;
  await core.close();
  const recovered = await open();
  const uncertain = await recovered.control({...operation, action: 'turn_off'}, {origin: interrupted});
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.reason, 'core_restarted_during_dispatch');
  assert.equal(recovered.client.calls.length, 0);
});
