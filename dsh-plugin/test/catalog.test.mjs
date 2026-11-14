import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {HomeCore} from '../core/index.js';
import {fakeHA, until} from './fixture.mjs';

test('mixed catalog reloads enrolled targets and returns individual receipts across adapters', async t => {
  const remote = await fakeHA(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-catalog-'));
  const local = path.join(root, '.local');
  await fs.mkdir(local, {mode: 0o700});
  const catalogPath = path.join(local, 'catalog.json');
  const credentials = path.join(local, 'credentials.json');
  const control = path.join(local, 'control');
  const watch = path.join(local, 'watch');
  const xiaomi = (id, area, zones = []) => ({entity_id: 'light.' + id, name: id, area, zones,
    source: 'miot_lan', local_verified: true, control_allowed: true, actions: ['turn_on', 'turn_off'],
    miot_did: 'fixture.' + id, miot_config_path: path.join(local, id + '.json')});
  const desk = {entity_id: 'light.desk', area: '卧室', local_verified: true, control_allowed: true, source: 'live'};
  const sofa = xiaomi('sofa', '客厅', ['沙发侧']);
  const bed = xiaomi('bed', '卧室');
  const other = xiaomi('other', '书房', ['沙发侧']);
  const save = async (entries) => {
    const temp = catalogPath + '.tmp';
    await fs.writeFile(temp, JSON.stringify({entities: entries}), {mode: 0o600});
    await fs.rename(temp, catalogPath);
  };
  await save([]);
  await fs.writeFile(credentials, JSON.stringify({access_token: 'fixture'}), {mode: 0o600});
  for (const entry of [sofa, bed, other]) await fs.writeFile(entry.miot_config_path, '{"power":true,"brightness":50,"kelvin":3000}');
  await fs.writeFile(watch, `#!${process.execPath}
console.log(JSON.stringify({phase:'subscribed',source:'local-mips'}));
setInterval(() => {},1000);
`, {mode: 0o700});
  await fs.writeFile(control, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), get = key => args[args.indexOf(key)+1];
const file = get('-config'), state = JSON.parse(fs.readFileSync(file));
const emit = row => console.log(JSON.stringify(row));
if (get('-mode') === 'read') emit({phase:'readback',...state});
else {
 const value = JSON.parse(get('-value'));
 fs.writeFileSync(file, JSON.stringify({...state,power:value}));
 emit({phase:'write-ack',siid:2,piid:1,code:0});
 emit({phase:'write-confirmed',siid:2,piid:1,code:0,value});
}
`, {mode: 0o700});
  const presence = {entity_id: 'binary_sensor.presence', name: '卧室人在', area:'卧室',
    source:'live', local_verified:true};
  const core = new HomeCore({state: path.join(local, 'ledger'), ha_backend: 'mixed', catalog_path: catalogPath,
    entities: [desk, sofa, presence], adapters: {live: {url: remote.url, credentials_path: credentials},
      miot_lan: {control_binary: control, watch_binary: watch, gateway_path: credentials, identity_path: credentials}}});
  t.after(async () => { await core.close(); await fs.rm(root, {recursive:true, force:true}); });
  await core.start();
  assert.equal(core.controls.search('沙发侧')[0].entity_id, sofa.entity_id);
  assert.equal(core.controls.search('沙发侧')[0].miot_did, undefined);
  await save([bed, other, {entity_id: desk.entity_id, name: '台灯'}]);
  await until(() => core.controls.entities.has(bed.entity_id));
  await until(() => core.client.sources.miot_lan.ready);
  assert.equal(core.controls.search('台灯')[0].area, '卧室');
  remote.states.get('light.desk').state = 'on';
  const group = await core.controlLights({area:'卧室', action:'turn_off'});
  assert.equal(group.status, 'confirmed');
  assert.deepEqual(new Set(group.targets), new Set([desk.entity_id, bed.entity_id]));
  assert.ok(group.results.every(result => core.store.control(result.operation_id).status === 'confirmed'));
  assert.equal(remote.calls.length, 1);
  assert.equal((await core.controls.get(bed.entity_id)).state, 'off');
  assert.equal((await core.controlLights({zone:'沙发侧', action:'turn_off'})).reason, 'HA_LOCATION_AMBIGUOUS');
  assert.equal((await core.controlLights({area:'客厅', zone:'沙发侧', action:'turn_off'})).status, 'confirmed');
  await core.engine.put({id:'mixed-presence', name:'Cross-adapter presence', enabled:true,
    trigger:{type:'state', entity_id:presence.entity_id, from:'off', to:'on'},
    actions:[{type:'control', entity_id:bed.entity_id, action:'turn_on'}]}, 0);
  remote.broadcast(remote.stateEvent(presence.entity_id, 'on'));
  await until(() => core.store.runs({id:'mixed-presence'})[0]?.status === 'completed');
  assert.equal((await core.controls.get(bed.entity_id)).state, 'on');
  await save([{...bed, miot_did:'different'}, other]);
  await until(() => core.catalogError === 'HA_CATALOG_BINDING_CHANGED');
  assert.equal((await core.controls.get(bed.entity_id)).state, 'on');
});

test('standalone Core discovers fresh gateway inventory and handles vendor reports and commands', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-direct-'));
  const local = path.join(root, '.local');
  await fs.mkdir(local, {mode: 0o700});
  const watch = path.join(local, 'watch');
  const devices = path.join(local, 'devices.json');
  const vendorConfig = path.join(local, 'bridge.json');
  const vendorReport = path.join(local, 'vendor-state.private.json');
  const catalog = path.join(local, 'catalog.json');
  const lightConfig = path.join(local, 'light');
  const light = {did:'test.light', name:'测试灯', model:'test.light.v1', urn:'urn:miot-spec-v2:device:light',
    online:true, roomId:'1', roomName:'卧室'};
  const token = 'a'.repeat(50);
  const report = async (mode, at) => {
    await fs.writeFile(vendorReport + '.next', JSON.stringify({
      dreame:{at, push:true, state:{available:true, mode}},
    }), {mode:0o600});
    await fs.rename(vendorReport + '.next', vendorReport);
  };
  const calls = [];
  const bridge = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token || req.url !== '/api/vendor/dreame/command' || req.method !== 'POST') {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push(JSON.parse(body));
    res.end(JSON.stringify({status:'confirmed', state:{available:true, mode:'cleaning'}}));
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  let core;
  t.after(async () => {
    await core?.close();
    await new Promise(resolve => bridge.close(resolve));
    await fs.rm(root, {recursive:true, force:true});
  });
  await fs.writeFile(watch, `#!${process.execPath}
const fs = require('node:fs');
if (!process.argv.includes('-inventory')) process.exit(1);
console.log(JSON.stringify({phase:'subscribed',source:'local-mips'}));
const scan = () => console.log(JSON.stringify({phase:'inventory',source:'local-mips',
  devices:JSON.parse(fs.readFileSync(${JSON.stringify(devices)}))}));
scan();
setInterval(scan, 70);
`, {mode:0o700});
  await fs.writeFile(lightConfig, '#!/bin/sh\nprintf \'%s\\n\' \'{"phase":"readback","power":false,"brightness":25,"kelvin":3000}\'\n', {mode:0o700});
  await fs.writeFile(devices, JSON.stringify([light]));
  await fs.writeFile(catalog, JSON.stringify({entities:[]}), {mode:0o600});
  await fs.writeFile(vendorConfig, JSON.stringify({token}), {mode:0o600});
  const now = Date.now() / 1000;
  await report('docked', now);
  const entity_id = 'vacuum.dreame';
  core = new HomeCore({state:path.join(local, 'ledger'), ha_backend:'mixed', catalog_path:catalog,
    entities:[{entity_id, name:'追觅', source:'vendor', vendor:'dreame', local_verified:true,
      control_allowed:true, actions:['start']}],
    adapters:{miot_lan:{control_binary:lightConfig, watch_binary:watch, gateway_path:vendorConfig, identity_path:vendorConfig,
      discover:true}, vendor:{endpoint:'http://127.0.0.1:' + bridge.address().port, config_path:vendorConfig}}});
  const events = [];
  core.client.on('event', event => events.push(event));
  await core.start();
  await until(() => core.client.sources.vendor.ready && core.discovered().devices.length === 1);
  assert.equal(core.discovered().devices[0].status, 'pending_enrollment');
  assert.equal(core.controls.entities.has('light.fixture'), false);
  assert.equal(events.length, 0);
  const added = {...light, did:'test.new', roomName:'客厅'};
  await fs.writeFile(devices + '.next', JSON.stringify([light, added]));
  await fs.rename(devices + '.next', devices);
  await until(() => core.discovered().devices.length === 2);
  await fs.writeFile(catalog + '.next', JSON.stringify({entities:[{
    entity_id:'light.fixture', source:'miot_lan', local_verified:true, miot_did:light.did, miot_config_path:lightConfig,
  }]}), {mode:0o600});
  await fs.rename(catalog + '.next', catalog);
  await until(() => core.controls.entities.get('light.fixture')?.area === '卧室' && core.client.sources.miot_lan.ready);
  assert.equal(core.discovered().devices[0].status, 'enrolled');
  assert.equal(core.controls.search('卧室')[0].name, '测试灯');
  assert.equal((await core.controls.get(entity_id)).state, 'docked');
  assert.equal((await core.control({entity_id, action:'start'})).status, 'confirmed');
  assert.deepEqual(calls, [{name:'start', value:true}]);
  await report('cleaning', Date.now() / 1000);
  await until(() => events.length === 1);
  assert.equal(events[0].adapter, 'vendor');
  assert.equal(events[0].data.new_state.state, 'cleaning');
});
