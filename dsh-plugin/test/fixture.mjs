import http from 'node:http';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {HAClient} from '../client.js';
import {RuleStore} from '../store.js';
import {Controls} from '../controls.js';
import {RuleEngine} from '../engine.js';
import {validateSettings} from '../model.js';

export async function until(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('test deadline'); await delay(10); }
}

// A real HTTP + RFC6455 peer exercises native WebSocket, not a mocked HAClient.
function frame(text) {
  const payload = Buffer.from(text), header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81;
  if (payload.length < 126) header[1] = payload.length;
  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}
export async function fakeHA(t) {
  const peers = new Set(), calls = [], gets = [], auth = [];
  const states = new Map([
    ['binary_sensor.presence', {entity_id: 'binary_sensor.presence', state: 'off', attributes: {}}],
    ['sensor.lux', {entity_id: 'sensor.lux', state: '5', attributes: {}}],
    ['light.desk', {entity_id: 'light.desk', state: 'off', attributes: {
      supported_color_modes: ['color_temp'], brightness: 128, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500,
    }}],
    ['input_boolean.test', {entity_id: 'input_boolean.test', state: 'off', attributes: {}}],
    ['script.evening', {entity_id: 'script.evening', state: 'off', attributes: {}}],
    ['automation.evening', {entity_id: 'automation.evening', state: 'on', attributes: {}}],
  ]);
  const behavior = {drop: false, ignoreControl: false, redirect: false, rejectSubscription: false, refreshes: 0, pings: 0};
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url === '/auth/token') { behavior.refreshes++; res.end(JSON.stringify({access_token: 'refreshed', expires_in: 3600})); return; }
    auth.push(req.headers.authorization);
    if (behavior.redirect) { res.writeHead(302, {Location: 'http://203.0.113.1/'}); res.end(); return; }
    if (req.url.startsWith('/api/states/')) {
      const id = req.url.slice('/api/states/'.length); gets.push(id);
      res.writeHead(states.has(id) ? 200 : 404); res.end(JSON.stringify(states.get(id) ?? {})); return;
    }
    if (req.url === '/api/states') { res.end(JSON.stringify([...states.values()])); return; }
    if (req.url.startsWith('/api/services/')) {
      const data = JSON.parse(raw), [, , , domain, action] = req.url.split('/');
      calls.push({domain, action, data});
      if (behavior.drop) { req.socket.destroy(); return; }
      if (!behavior.ignoreControl && states.has(data.entity_id)) {
        const state = states.get(data.entity_id);
        state.state = action === 'turn_off' || data.brightness_pct === 0 ? 'off' : 'on';
        if (data.brightness_pct !== undefined) state.attributes.brightness = Math.round(data.brightness_pct * 255 / 100);
        if (data.color_temp_kelvin !== undefined) state.attributes.color_temp_kelvin = data.color_temp_kelvin;
      }
      res.end('[]'); return;
    }
    res.writeHead(404); res.end('{}');
  });
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const peer = {socket, subscriptions: new Map(), send(value) { socket.write(frame(JSON.stringify(value))); }};
    peers.add(peer); socket.on('error', () => {}); socket.on('close', () => peers.delete(peer));
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 15, masked = !!(pending[1] & 128);
        let length = pending[1] & 127, offset = 2;
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); offset = 10; }
        if (pending.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? pending.subarray(offset, offset + 4) : null; if (masked) offset += 4;
        const payload = Buffer.from(pending.subarray(offset, offset + length)); pending = pending.subarray(offset + length);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const msg = JSON.parse(payload.toString());
        if (msg.type === 'auth') peer.send({type: msg.access_token === 'bad' ? 'auth_invalid' : 'auth_ok'});
        if (msg.type === 'subscribe_events') {
          peer.subscriptions.set(msg.id, msg.event_type);
          peer.send({id: msg.id, type: 'result', success: !behavior.rejectSubscription});
        }
        if (msg.type === 'ping') { behavior.pings++; peer.send({id: msg.id, type: 'pong'}); }
      }
    });
    peer.send({type: 'auth_required'});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const peer of peers) peer.socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  function broadcast(event) {
    for (const peer of peers) for (const [id, type] of peer.subscriptions)
      if (type === event.event_type) peer.send({id, type: 'event', event});
  }
  function stateEvent(id, to, {from, time = new Date().toISOString(), context = 'ctx'} = {}) {
    const old = structuredClone(states.get(id)); if (from !== undefined) old.state = from;
    const current = structuredClone(old); current.state = to; states.set(id, current);
    return {event_type: 'state_changed', time_fired: time, data: {entity_id: id, old_state: old, new_state: current}, context: {id: context}};
  }
  return {url: `http://127.0.0.1:${server.address().port}`, peers, calls, gets, auth, states, behavior, broadcast, stateEvent,
    disconnect() { for (const peer of peers) peer.socket.destroy(); }};
}

export const rule = (extra = {}) => ({id: 'presence-light', name: '人在且较暗时开灯', enabled: true,
  trigger: {type: 'state', entity_id: 'binary_sensor.presence', from: 'off', to: 'on'},
  conditions: [{entity_id: 'sensor.lux', below: 30}],
  actions: [{type: 'control', entity_id: 'light.desk', action: 'set_brightness', value: 40}], cooldown_ms: 1000, ...extra});

export async function fixture(t, extra = {}) {
  const ha = await fakeHA(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-plugin-'));
  const directory = path.join(root, '.local', 'home-assistant'); await fs.mkdir(directory, {recursive: true});
  const credentials = path.join(directory, 'credentials.private.json');
  await fs.writeFile(credentials, JSON.stringify({access_token: 'fixture'}), {mode: 0o600});
  const settings = {url: ha.url, credentials_path: credentials, state: path.join(directory, 'rules'),
    entities: [...ha.states.keys()].map(entity_id => ({entity_id, name: entity_id, local_verified: true,
      control_allowed: !/^(binary_sensor|sensor)\./.test(entity_id)})), ...extra};
  const client = new HAClient(settings, {reconnectMin: 20, reconnectMax: 100, heartbeatMs: 100});
  const store = new RuleStore(settings.state); await store.open();
  const controls = new Controls(client, validateSettings(settings), {pollMs: 5, attempts: 2});
  const engine = new RuleEngine({store, client, controls, settings});
  client.on('event', (event, generation) => engine.accept(event, generation));
  client.on('gap', details => engine.gap(details).catch(() => {}));
  client.start(); await until(() => client.ready);
  t.after(async () => { const closing = client.close(); await engine.close(); await closing; await store.close();
    await fs.rm(root, {recursive: true, force: true}); });
  return {ha, root, directory, settings, credentials, client, store, controls, engine};
}
