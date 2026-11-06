import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {Context} from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Agents from '@deepseek-ai/dsh-agent';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import HomeAssistant from '../index.js';

const example = JSON.parse(await fs.readFile(new URL('../simulated.example.json', import.meta.url), 'utf8'));

test('simulated plugin needs no HA credentials and executes rules entirely in process', async t => {
  let networkCalls = 0;
  const denied = () => { networkCalls++; throw new Error('network forbidden in simulated test'); };
  t.mock.method(http, 'request', denied); t.mock.method(https, 'request', denied);
  t.mock.method(globalThis, 'WebSocket', denied);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-simulated-'));
  const state = path.join(root, '.local', 'rules');
  const settingsPath = path.join(root, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({...example, state}));
  const ctx = new Context(), fibers = [];
  const mount = (plugin, config = {}) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); return fiber; };
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await fs.rm(root, {recursive: true, force: true}); });
  mount(Sessions); mount(Projections); mount(Agents); mount(Prompt); mount(Tools);
  mount(Persistence, {root: path.join(root, '.local', 'sessions'), compression: 'none'});
  await Promise.all(fibers.map(fiber => fiber.await()));
  const plugin = mount(HomeAssistant, {settingsPath}); await plugin.await();
  const service = ctx.homeAssistant;
  assert.equal(service.client.simulated, true);
  assert.equal(service.status().connection.ready, true);
  assert.equal(service.status().connection.backend, 'simulated');
  const exec = {signal: new AbortController().signal};
  const rule = {
    id: 'simulated-presence', name: '模拟客厅有人且暗时照明', enabled: true,
    trigger: {type: 'state', entity_id: 'binary_sensor.living_presence', from: 'off', to: 'on'},
    conditions: [{entity_id: 'sensor.living_illuminance', below: 30}], cooldown_ms: 60000,
    actions: [
      {type: 'control', entity_id: 'light.living', action: 'set_brightness', value: 40},
      {type: 'control', entity_id: 'light.living', action: 'set_color_temperature', value: 3000},
    ],
  };
  const put = ctx.tools.get('ha_rule_put');
  await assert.rejects(put.execute({expected_revision: 0, rule: {...rule, id: 'invalid-trigger',
    trigger: {type: 'state', entity_id: 'sensor.living_illuminance', from: 'off', to: 'on', for_ms: 2000}}}, exec),
    /HA_TRIGGER_VALUE_MISMATCH/);
  await assert.rejects(put.execute({expected_revision: 0, rule: {...rule, id: 'invalid-attribute',
    conditions: [{entity_id: 'sensor.living_illuminance', attribute: 'illuminance', below: 30}]}}, exec),
    /HA_CONDITION_ATTRIBUTE_MISSING/);
  assert.equal(service.engine.list().length, 0);
  const saved = await put.execute({expected_revision: 0, rule}, exec);
  assert.equal(saved.revision, 1);
  assert.equal(service.client.calls.length, 0);
  // A bright room must not trigger the saved action.
  service.client.setState('sensor.living_illuminance', '100');
  service.client.setState('binary_sensor.living_presence', 'on');
  await service.engine.tail;
  assert.equal(service.client.calls.length, 0);
  service.client.setState('binary_sensor.living_presence', 'off');
  service.client.setState('sensor.living_illuminance', '5');
  service.client.setState('binary_sensor.living_presence', 'on');
  await service.engine.tail;
  const light = await ctx.tools.get('ha_get_state').execute({entity_id: 'light.living'}, exec);
  assert.equal(light.simulated, true);
  assert.equal(light.state, 'on');
  assert.equal(light.attributes.brightness, 102);
  assert.equal(light.attributes.color_temp_kelvin, 3000);
  assert.equal(service.status().recent_runs[0].status, 'completed');
  assert.equal(service.client.calls.length, 2);
  assert.equal(networkCalls, 0);
  await plugin.dispose(); assert.equal(service.client.ready, false);
});
