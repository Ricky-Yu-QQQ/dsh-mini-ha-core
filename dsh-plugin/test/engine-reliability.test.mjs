import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture, rule, until} from './fixture.mjs';
import {RuleStore} from '../store.js';
import {RuleEngine} from '../engine.js';

test('durable execution request survives replacement and deletion of the source rule', async t => {
  const h = await fixture(t, {event_types: ['nomi_button']});
  h.engine.registerCallback('remember', () => {});
  const saved = await h.engine.put(rule({trigger: {type: 'event', event_type: 'nomi_button', data: {button: 'desk'}},
    actions: [{type: 'callback', name: 'remember', payload: {room: 'desk'}}]}), 0);
  const event = {event_type: 'nomi_button', time_fired: new Date().toISOString(),
    data: {button: 'desk', sequence: 17}, context: {id: 'original-request'}};
  h.engine.accept(event, h.client.generation); await h.engine.tail;
  const replacement = await h.engine.put(rule({enabled: false}), 1);
  await h.engine.remove(saved.id, replacement.revision);
  await h.store.close(); await h.store.open();
  const [run] = h.store.snapshot().runs;
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.request, {rule: saved, event});
  assert.equal(h.engine.list().length, 0);
});

test('each side effect has a durable action claim and crash recovery never retries it', async t => {
  const h = await fixture(t); let entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  h.engine.registerCallback('first', () => {});
  h.engine.registerCallback('second', async () => { entered = true; await gate; });
  const saved = await h.engine.put(rule({actions: [{type: 'callback', name: 'first'},
    {type: 'callback', name: 'second', payload: {request: 'second-side-effect'}}]}), 0);
  const event = h.ha.stateEvent('binary_sensor.presence', 'on');
  h.engine.accept(event, h.client.generation);
  try {
    await until(() => entered);
    const durable = JSON.parse(await fs.readFile(h.store.file, 'utf8'));
    assert.equal(durable.runs[0].action_claim?.index, 1);
    assert.equal(durable.runs[0].results.length, 1);
    assert.deepEqual(durable.runs[0].request, {rule: saved, event});
    const recoveredDirectory = path.join(h.directory, 'crash-copy');
    await fs.mkdir(recoveredDirectory);
    await fs.writeFile(path.join(recoveredDirectory, 'rules.private.json'), JSON.stringify(durable));
    const recovered = new RuleStore(recoveredDirectory); await recovered.open();
    const restarted = new RuleEngine({store: recovered, client: h.client, controls: h.controls, settings: h.settings});
    try {
      let retried = 0;
      restarted.registerCallback('first', () => { retried++; });
      restarted.registerCallback('second', () => { retried++; });
      const [interrupted] = recovered.snapshot().runs;
      assert.equal(interrupted.status, 'interrupted');
      assert.equal(interrupted.action_claim.index, 1);
      // Remove cooldown as an independent reason to suppress the already claimed event.
      await recovered.transact(data => { delete data.cooldowns[saved.id]; });
      restarted.accept(event, h.client.generation); await restarted.tail;
      assert.equal(retried, 0);
      assert.equal(recovered.snapshot().runs.length, 1);
    } finally { await restarted.close(); await recovered.close(); }
  } finally { release(); await h.engine.tail; }
  assert.equal(h.store.snapshot().runs[0].action_claim, null);
});

test('closing the store stops admitting transactions before ownership is released', async t => {
  const h = await fixture(t);
  const closing = h.store.close();
  try {
    await assert.rejects(h.store.transact(data => { data.gaps.push({reason: 'late-writer'}); }), /HA_STORE_CLOSED/);
    await closing;
  } finally { await closing; await h.store.open(); }
  assert.equal(h.store.snapshot().gaps.some(gap => gap.reason === 'late-writer'), false);
});

test('duplicate state events do not extend an already running continuous-state timer', async t => {
  const h = await fixture(t);
  await h.engine.put(rule({trigger: {...rule().trigger, for_ms: 100}}), 0);
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
  try {
    const event = h.ha.stateEvent('binary_sensor.presence', 'on');
    h.engine.accept(event, h.client.generation);
    t.mock.timers.tick(60);
    h.engine.accept(event, h.client.generation);
    t.mock.timers.tick(40); await h.engine.tail;
    assert.equal(h.ha.calls.length, 1);
  } finally { t.mock.timers.reset(); }
});

test('queue residence expires an event before a blocked prior action finishes', async t => {
  const h = await fixture(t, {event_types: ['nomi_button'], max_event_age_ms: 100});
  let entered = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  h.engine.registerCallback('wait', async () => { entered++; await gate; });
  await h.engine.put(rule({trigger: {type: 'event', event_type: 'nomi_button', data: {}}, conditions: [],
    actions: [{type: 'callback', name: 'wait'}]}), 0);
  const event = sequence => ({event_type: 'nomi_button', time_fired: new Date().toISOString(), data: {sequence}});
  h.engine.accept(event(1), h.client.generation); await until(() => entered === 1);
  h.engine.accept(event(2), h.client.generation);
  try { await delay(150); } finally { release(); }
  await h.engine.tail;
  assert.equal(entered, 1);
  assert.equal(h.engine.health.dropped, 1);
});

test('persisted cooldown suppresses a distinct fresh event after reopening the store', async t => {
  const h = await fixture(t);
  await h.engine.put(rule({cooldown_ms: 60000}), 0);
  h.engine.accept(h.ha.stateEvent('binary_sensor.presence', 'on', {context: 'first'}), h.client.generation);
  await h.engine.tail;
  await h.store.close(); await h.store.open();
  h.engine.accept(h.ha.stateEvent('binary_sensor.presence', 'on', {from: 'off', context: 'distinct'}), h.client.generation);
  await h.engine.tail;
  assert.equal(h.ha.calls.length, 1);
  assert.equal(h.store.snapshot().runs.length, 1);
});
