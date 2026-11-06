import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HAClient} from '../client.js';
import {Controls} from '../controls.js';
import {validateSettings} from '../model.js';

// Only loopback HTTP is used here; no household HA endpoint or credentials.
async function localHA(t, handler, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-transport-'));
  const credentials = path.join(directory, 'credential.private.json');
  await fs.writeFile(credentials, JSON.stringify({access_token: 'test'}), {mode: 0o600});
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({method: request.method, route: request.url, authorization: request.headers.authorization, body});
    await handler(request, response, body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings = {url: `http://127.0.0.1:${server.address().port}`, credentials_path: credentials,
    request_timeout_ms: 150, entities: [], ...options};
  const client = new HAClient(settings);
  t.after(async () => {
    await client.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, {recursive: true, force: true});
  });
  return {client, credentials, requests, settings};
}

test('REST state routes reject writes before opening a request', async t => {
  const h = await localHA(t, (_request, response) => response.end('{}'));
  await assert.rejects(h.client.request('/api/states/light.test', {state: 'on'}), /HA_ROUTE_DENIED/);
  assert.equal(h.requests.length, 0);
});

test('REST service routes require a POST body rather than a GET', async t => {
  const h = await localHA(t, (_request, response) => response.end('[]'));
  await assert.rejects(h.client.request('/api/services/light/turn_on'), /HA_ROUTE_DENIED/);
  assert.equal(h.requests.length, 0);
});

test('credential rotation fences a refresh response from the previous token generation', async t => {
  let beginRefresh, finishRefresh;
  const began = new Promise(resolve => { beginRefresh = resolve; });
  const finish = new Promise(resolve => { finishRefresh = resolve; });
  t.after(() => finishRefresh());
  const h = await localHA(t, async (request, response) => {
    if (request.url === '/auth/token') {
      beginRefresh(); await finish;
      response.end(JSON.stringify({access_token: 'refreshed-old-generation', expires_in: 3600}));
    } else response.end('{}');
  }, {request_timeout_ms: 1000});
  await fs.writeFile(h.credentials, JSON.stringify({access_token: 'expired', expires_at: 1,
    refresh_token: 'old-refresh', client_id: 'test'}));
  const refreshing = h.client.credential();
  await began;
  const rotated = JSON.stringify({access_token: 'rotated', expires_at: Date.now() / 1000 + 3600});
  await fs.writeFile(h.credentials, rotated);
  assert.equal(await h.client.credential(), 'rotated');
  finishRefresh();
  assert.equal(await refreshing, 'rotated');
  await h.client.state('light.test');
  assert.equal(h.requests.at(-1).authorization, 'Bearer rotated');
  assert.equal(await fs.readFile(h.credentials, 'utf8'), rotated);
});

test('control captures validated parameters before waiting in its per-entity queue', async t => {
  let state = {entity_id: 'light.test', state: 'on', attributes: {supported_color_modes: ['onoff']}};
  const h = await localHA(t, (request, response) => {
    if (request.url.startsWith('/api/services/')) {
      state = {...state, state: request.url.endsWith('/turn_off') ? 'off' : 'on'};
      response.end('[]');
    } else response.end(JSON.stringify(state));
  }, {entities: [{entity_id: 'light.test', local_verified: true, control_allowed: true, actions: ['turn_on']}]});
  const controls = new Controls(h.client, validateSettings(h.settings), {attempts: 1});
  const operation = {entity_id: 'light.test', action: 'turn_on'};
  const result = controls.control(operation);
  operation.action = 'turn_off';
  assert.equal((await result).requested.action, 'turn_on');
  assert.equal(h.requests.filter(request => request.route.startsWith('/api/services/')).length, 0);
});

test('malformed climate state cannot count as a confirmed turn-on', async t => {
  const h = await localHA(t, (_request, response) => response.end(JSON.stringify({entity_id: 'climate.test', attributes: {}})),
    {entities: [{entity_id: 'climate.test', local_verified: true, control_allowed: true}]});
  const controls = new Controls(h.client, validateSettings(h.settings), {attempts: 1});
  await assert.rejects(controls.control({entity_id: 'climate.test', action: 'turn_on'}), /HA_INVALID_STATE/);
  assert.equal(h.requests.filter(request => request.route.startsWith('/api/services/')).length, 0);
});

test('REST absolute timeout terminates a trickling response without retry', async t => {
  let streaming;
  t.after(() => clearInterval(streaming));
  const h = await localHA(t, (_request, response) => {
    response.writeHead(200); response.write('[');
    streaming = setInterval(() => response.write(' '), 10);
    response.once('close', () => clearInterval(streaming));
  }, {request_timeout_ms: 80});
  const began = Date.now();
  await assert.rejects(h.client.state('light.test'), /HA_TRANSPORT_UNCERTAIN|HA_RESPONSE_INTERRUPTED/);
  assert.ok(Date.now() - began < 500, 'an active response must still have an absolute deadline');
  assert.equal(h.requests.length, 1);
});

test('control distinguishes service rejection, uncertain acceptance, and unchanged readback', async t => {
  let status = 403;
  const state = {entity_id: 'light.test', state: 'off', attributes: {supported_color_modes: ['onoff']}};
  const h = await localHA(t, (request, response) => {
    if (request.url.startsWith('/api/services/')) { response.writeHead(status); response.end('[]'); }
    else response.end(JSON.stringify(state));
  }, {entities: [{entity_id: 'light.test', local_verified: true, control_allowed: true}]});
  const controls = new Controls(h.client, validateSettings(h.settings), {attempts: 1});
  const operation = {entity_id: 'light.test', action: 'turn_on'};
  await assert.rejects(controls.control(operation), /HA_HTTP_403/);
  status = 503;
  assert.equal((await controls.control(operation)).status, 'uncertain');
  status = 200;
  assert.equal((await controls.control(operation)).status, 'unconfirmed');
  assert.equal(h.requests.filter(request => request.route.startsWith('/api/services/')).length, 3);
});
