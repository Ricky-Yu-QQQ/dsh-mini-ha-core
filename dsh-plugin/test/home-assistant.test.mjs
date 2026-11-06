import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture, rule, until} from './fixture.mjs';
import {lanURL} from '../client.js';
import {RuleStore} from '../store.js';

test('fixed LAN endpoint rejects public hosts, credentials, paths and DNS', () => {
  for (const value of ['http://example.com', 'http://8.8.8.8', 'http://169.254.1.1', 'http://0.0.0.0',
    'http://user:secret@192.168.1.1', 'http://192.168.1.1/api', 'file:///tmp/a', 'http://192.168.1.1/?x=1'])
    assert.throws(() => lanURL(value));
  assert.equal(lanURL('http://192.168.1.10:80'), 'http://192.168.1.10');
});

test('native WS authenticates, subscribes, pings and reconnects with a recorded gap', async t => {
  const h = await fixture(t);
  assert.equal(h.client.health.generation, 1);
  await until(() => h.ha.behavior.pings > 0);
  h.ha.disconnect();
  await until(() => h.client.ready && h.client.generation > 1);
  // Socket readiness and the async atomic store commit have separate lifetimes.
  await until(() => h.store.snapshot().gaps.length > 0);
  assert.ok(h.store.snapshot().gaps.length > 0);
});

test('REST brightness, Kelvin, on/off and script use exact service APIs and readback', async t => {
  const h = await fixture(t);
  for (const operation of [
    {entity_id: 'light.desk', action: 'set_brightness', value: 40},
    {entity_id: 'light.desk', action: 'set_color_temperature', value: 3000},
    {entity_id: 'light.desk', action: 'turn_off'},
    {entity_id: 'input_boolean.test', action: 'turn_on'},
  ]) assert.equal((await h.controls.control(operation)).status, 'confirmed');
  assert.deepEqual(h.ha.calls[0], {domain: 'light', action: 'turn_on', data: {entity_id: 'light.desk', brightness_pct: 40}});
  assert.equal(h.ha.calls[1].data.color_temp_kelvin, 3000);
  assert.equal((await h.controls.logic('automation.evening')).status, 'accepted');
  assert.deepEqual(h.ha.calls.at(-1), {domain: 'automation', action: 'trigger', data: {entity_id: 'automation.evening', skip_condition: false}});
  assert.ok(h.ha.auth.every(value => value === 'Bearer fixture'));
});

test('out-of-range, unsupported, unavailable and unenrolled commands send no control requests', async t => {
  const h = await fixture(t);
  for (const operation of [
    {entity_id: 'light.desk', action: 'set_brightness', value: 101},
    {entity_id: 'light.desk', action: 'set_color_temperature', value: 1800},
    {entity_id: 'binary_sensor.presence', action: 'turn_off'},
    {entity_id: 'light.unknown', action: 'turn_on'},
    {entity_id: 'script.evening', action: 'turn_on'},
  ]) await assert.rejects(async () => h.controls.control(operation));
  h.ha.states.get('light.desk').attributes.supported_color_modes = ['onoff'];
  await assert.rejects(h.controls.control({entity_id: 'light.desk', action: 'set_brightness', value: 40}), /UNSUPPORTED/);
  h.ha.states.get('light.desk').state = 'unavailable';
  await assert.rejects(h.controls.control({entity_id: 'light.desk', action: 'turn_on'}), /UNAVAILABLE/);
  assert.equal(h.ha.calls.length, 0);
});

test('uncertain transport never retries, and unchanged readback never reports success', async t => {
  const h = await fixture(t);
  h.ha.behavior.drop = true;
  assert.equal((await h.controls.control({entity_id: 'light.desk', action: 'turn_on'})).status, 'uncertain');
  assert.equal(h.ha.calls.length, 1);
  h.ha.behavior.drop = false; h.ha.behavior.ignoreControl = true;
  assert.equal((await h.controls.control({entity_id: 'light.desk', action: 'turn_on'})).status, 'unconfirmed');
  assert.equal(h.ha.calls.length, 2);
});

test('redirects are refused, and expiring shared credentials refresh once without file mutation', async t => {
  const h = await fixture(t);
  h.ha.behavior.redirect = true;
  await assert.rejects(h.controls.get('light.desk'), /HA_HTTP_302/);
  h.ha.behavior.redirect = false;
  const content = JSON.stringify({access_token: 'old', expires_at: 1, refresh_token: 'private-refresh', client_id: 'test'});
  await fs.writeFile(h.credentials, content);
  await Promise.all([h.controls.get('light.desk'), h.controls.get('sensor.lux')]);
  assert.equal(h.ha.behavior.refreshes, 1);
  assert.equal(h.ha.auth.at(-1), 'Bearer refreshed');
  assert.equal(await fs.readFile(h.credentials, 'utf8'), content);
});

test('presence event executes a persisted light rule once, duplicate event is suppressed', async t => {
  const h = await fixture(t);
  await h.engine.put(rule(), 0);
  const event = h.ha.stateEvent('binary_sensor.presence', 'on');
  h.ha.broadcast(event); h.ha.broadcast(event);
  await until(() => h.store.snapshot().runs.some(run => run.status === 'completed'));
  await h.engine.tail;
  assert.equal(h.ha.calls.length, 1);
  assert.equal(h.store.snapshot().runs.length, 1);
  assert.equal(h.ha.calls[0].data.brightness_pct, 40);
  assert.equal((await fs.stat(h.store.file)).mode & 0o777, 0o600);
});

test('attribute-only updates, snapshots, stale events and failed conditions do not fire', async t => {
  const h = await fixture(t); await h.engine.put(rule(), 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'off'));
  const snapshot = h.ha.stateEvent('binary_sensor.presence', 'on'); snapshot.data.old_state = null;
  h.ha.broadcast(snapshot);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on', {from: 'off', time: '2020-01-01T00:00:00Z'}));
  h.ha.states.get('sensor.lux').state = '100';
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on', {from: 'off'}));
  await delay(80); await h.engine.tail;
  assert.equal(h.ha.calls.length, 0); assert.equal(h.store.snapshot().runs.length, 0);
  assert.equal(h.engine.health.dropped, 1);
});

test('for_ms requires a continuous state and is cancelled across a disconnect', async t => {
  const h = await fixture(t);
  await h.engine.put(rule({trigger: {...rule().trigger, for_ms: 100}}), 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.engine.timers.size === 1);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'off'));
  await delay(130);
  assert.equal(h.ha.calls.length, 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.engine.timers.size === 1);
  h.ha.disconnect(); await delay(150);
  assert.equal(h.ha.calls.length, 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on', {from: 'off'}));
  await until(() => h.ha.calls.length === 1);
});

test('atomic revision conflict, dry-run and delete never create unintended actions', async t => {
  const h = await fixture(t);
  const first = await h.engine.put(rule(), 0); assert.equal(first.revision, 1);
  await assert.rejects(h.engine.put(rule(), 0), /REVISION_CONFLICT/);
  const outcomes = await Promise.allSettled([
    h.engine.put(rule({name: 'A'}), 1), h.engine.put(rule({name: 'B'}), 1),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const event = h.ha.stateEvent('binary_sensor.presence', 'on');
  assert.equal((await h.engine.dryRun(first.id, event)).matched, true);
  assert.equal(h.ha.calls.length, 0);
  await assert.rejects(h.engine.remove(first.id, 1), /REVISION_CONFLICT/);
  await h.engine.remove(first.id, 2); h.ha.broadcast(event);
  await delay(30); assert.equal(h.ha.calls.length, 0);
});

test('registered callbacks receive event and payload; missing bindings fail before partial actions', async t => {
  const h = await fixture(t); const received = [];
  const release = h.engine.registerCallback('existing.logic', context => received.push(context));
  await h.engine.put(rule({actions: [{type: 'callback', name: 'existing.logic', payload: {room: 'desk'}}]}), 0);
  release();
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await delay(30); await h.engine.tail;
  assert.equal(h.store.snapshot().runs.length, 0);
  assert.equal(h.engine.health.last_error, 'HA_CALLBACK_NOT_BOUND');
  h.engine.registerCallback('existing.logic', context => received.push(context));
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on', {from: 'off'}));
  await until(() => received.length === 1); await h.engine.tail;
  assert.equal(received[0].event.data.entity_id, 'binary_sensor.presence');
  assert.equal(received[0].payload.room, 'desk');
  assert.equal(h.store.snapshot().runs[0].status, 'completed');
});

test('custom event subscription filters exact fields and invokes HA script', async t => {
  const h = await fixture(t, {event_types: ['nomi_button']});
  await h.engine.put(rule({trigger: {type: 'event', event_type: 'nomi_button', data: {button: 'desk'}},
    actions: [{type: 'ha_logic', entity_id: 'script.evening'}]}), 0);
  h.ha.broadcast({event_type: 'nomi_button', time_fired: new Date().toISOString(), data: {button: 'other'}});
  h.ha.broadcast({event_type: 'nomi_button', time_fired: new Date().toISOString(), data: {button: 'desk'}});
  await until(() => h.ha.calls.length === 1); await h.engine.tail;
  assert.equal(h.ha.calls[0].domain, 'script');
});

test('unconfirmed action stops later callbacks and keeps the failure record', async t => {
  const h = await fixture(t); let called = false;
  h.engine.registerCallback('next', () => { called = true; });
  await h.engine.put(rule({actions: [...rule().actions, {type: 'callback', name: 'next'}]}), 0);
  h.ha.behavior.ignoreControl = true;
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.store.snapshot().runs[0]?.status === 'failed');
  assert.equal(called, false);
  assert.equal(h.store.snapshot().runs[0].error, 'HA_ACTION_UNCONFIRMED');
  assert.equal(h.store.snapshot().runs[0].results[0].result.status, 'unconfirmed');
});

test('rule replacement while running fences all remaining actions', async t => {
  const h = await fixture(t); let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  h.engine.registerCallback('wait', async () => { entered = true; await gate; });
  await h.engine.put(rule({actions: [{type: 'callback', name: 'wait'}, ...rule().actions]}), 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => entered);
  await h.engine.put(rule({enabled: false}), 1); release(); await h.engine.tail;
  assert.equal(h.ha.calls.length, 0);
  assert.equal(h.store.snapshot().runs[0].error, 'HA_RULE_CHANGED');
});

test('store ownership, crash claim recovery and durable cooldown prevent replay after restart', async t => {
  const h = await fixture(t);
  const other = new RuleStore(h.settings.state);
  await assert.rejects(other.open(), /ALREADY_OWNED/);
  await h.engine.put(rule(), 0);
  const event = h.ha.stateEvent('binary_sensor.presence', 'on'); h.ha.broadcast(event);
  await until(() => h.store.snapshot().runs[0]?.status === 'completed');
  await h.store.transact(data => { data.runs[0].status = 'running'; });
  await h.store.close();
  await h.store.open();
  assert.equal(h.store.snapshot().runs[0].status, 'interrupted');
  h.ha.broadcast(event); await delay(30); await h.engine.tail;
  assert.equal(h.store.snapshot().runs.length, 1); assert.equal(h.ha.calls.length, 1);
});

test('bounded queue reports overflow and close aborts a cooperative callback', async t => {
  const h = await fixture(t, {max_queue: 1}); let entered = false;
  h.engine.registerCallback('slow', ({signal}) => new Promise((resolve, reject) => {
    entered = true; signal.addEventListener('abort', () => reject(new Error('HA_CANCELLED')), {once: true});
  }));
  await h.engine.put(rule({actions: [{type: 'callback', name: 'slow'}]}), 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on')); await until(() => entered);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on', {from: 'off', context: 'second'}));
  await until(() => h.engine.health.dropped > 0);
  await h.engine.close();
  assert.equal(h.store.snapshot().runs[0].status, 'failed');
  assert.ok(h.store.snapshot().gaps.some(gap => gap.reason === 'queue_overflow'));
});
