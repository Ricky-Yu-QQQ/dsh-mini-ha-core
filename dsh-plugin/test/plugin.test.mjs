import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {Context} from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm, {createUserMessage} from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools, {defineTool} from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Credentials from '@deepseek-ai/dsh-credentials';
import HomeAssistant from '../index.js';
import {fakeHA, rule, until} from './fixture.mjs';

class TestCredentials extends Credentials {
  async resolve() { return {value: 'test', source: 'env'}; }
}

async function harness(t, respond = () => [{delta: {content: '已处理。'}}, {delta: {}, finish_reason: 'stop'}], overrides = {}) {
  const ha = await fakeHA(t), root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ha-'));
  const directory = path.join(root, '.local'); await fs.mkdir(directory);
  const credentials = path.join(directory, 'credential.private.json');
  await fs.writeFile(credentials, JSON.stringify({access_token: 'test'}));
  const settings = {url: ha.url, credentials_path: credentials, state: path.join(directory, 'rules'),
    entities: [...ha.states.keys()].map(entity_id => ({entity_id, local_verified: true, control_allowed: true})),
    agent: {provider: 'test-provider', model: 'test', max_tool_calls: 4}, ...overrides};
  const settingsPath = path.join(directory, 'settings.private.json');
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    const chunks = await respond(body, requests.length);
    for (const choice of chunks) res.write('data: ' + JSON.stringify({id: 'test', object: 'chat.completion.chunk',
      created: 1, model: 'test', choices: [{index: 0, ...choice}]}) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const ctx = new Context(), fibers = [];
  const mount = (plugin, config = {}) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); return fiber; };
  mount(Sessions); mount(Projections); mount(Agents); mount(Prompt); mount(Tools); mount(NativeExecutor);
  mount(Llm); mount(TestCredentials); mount(Persistence, {root: path.join(directory, 'sessions'), compression: 'none'});
  process.env.HA_TEST_KEY = 'test';
  mount(PiAi, {providers: {'test-provider': {api: 'openai-completions', apiKeyEnv: 'HA_TEST_KEY',
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`, retryPolicy: {mode: 'normal', maxRetries: 0},
    models: [{id: 'test', name: 'test', contextWindow: 8192, maxTokens: 512, reasoningEfforts: false}],
    compat: {supportsStore: false, supportsDeveloperRole: false}}}});
  mount(AgentLoop, {maxParallelToolCalls: 1});
  await Promise.all(fibers.map(fiber => fiber.await()));
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await fs.rm(root, {recursive: true, force: true});
  });
  const plugin = mount(HomeAssistant, {settingsPath}); await plugin.await();
  await until(() => ctx.homeAssistant.client.ready);
  return {ctx, plugin, ha, root, directory, settings, settingsPath, mount, requests};
}

const toolCall = (name, args) => [{delta: {role: 'assistant', tool_calls: [{index: 0, id: 'call_one', type: 'function',
  function: {name, arguments: JSON.stringify(args)}}]}}, {delta: {}, finish_reason: 'tool_calls'}];

test('actual Cordis service mounts tools, persists rules, unloads and re-enables', async t => {
  const h = await harness(t);
  assert.equal(h.ctx.tools.definitions().length, 9);
  const tool = h.ctx.tools.get('ha_rule_put');
  const saved = await tool.execute({rule: rule(), expected_revision: 0}, {signal: new AbortController().signal});
  assert.equal(saved.revision, 1);
  await h.plugin.dispose();
  assert.equal(h.ctx.get('homeAssistant'), undefined);
  assert.equal(h.ctx.tools.get('ha_control'), undefined);
  const next = h.mount(HomeAssistant, {settingsPath: h.settingsPath}); await next.await();
  await until(() => h.ctx.homeAssistant.client.ready);
  assert.equal(h.ctx.homeAssistant.engine.list().length, 1);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.ha.calls.length === 1);
});

test('DSH Agent creates a persistent rule through a tool and the event wakes a restricted DSH callback', async t => {
  const spec = rule({actions: [{type: 'agent', prompt: '确认有人时把桌灯亮度调到40%。'}]});
  const h = await harness(t, body => {
    const hasTool = body.messages.some(message => message.role === 'tool');
    if (hasTool) return [{delta: {content: '已完成。'}}, {delta: {}, finish_reason: 'stop'}];
    const owner = body.messages.some(message => typeof message.content === 'string' && message.content.includes('创建规则'));
    return owner ? toolCall('ha_rule_put', {rule: spec, expected_revision: 0})
      : toolCall('ha_control', {entity_id: 'light.desk', action: 'set_brightness', value: 40});
  });
  h.ctx.tools.register(defineTool({name: 'admin_shell', description: 'Must not reach event Agent', parameters: {},
    output: {schema: {type: 'json'}, render: () => []}, execute: () => { throw new Error('unsafe'); }}));
  const owner = await h.ctx.agents.create({sessionId: 'owner-test', agentOptions: {provider: 'test-provider', model: 'test'}});
  owner.agent.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: '创建规则：有人时用 Agent 判断并调灯。'}]}));
  await owner.agent.whenIdle(); await owner.dispose();
  assert.equal(h.ctx.homeAssistant.engine.list().length, 1);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.ctx.homeAssistant.status().recent_runs[0]?.status === 'completed', 10000);
  assert.equal(h.ha.calls.length, 1);
  const background = h.requests.find(body => body.messages.some(message => typeof message.content === 'string' && message.content.includes('已保存规则的处理目标')));
  assert.deepEqual(background.tools.map(tool => tool.function.name).sort(), ['ha_control', 'ha_get_state', 'ha_run_logic', 'ha_search']);
  const run = h.ctx.homeAssistant.status().recent_runs[0];
  assert.match(run.results[0].result.session_id, /^ha-/);
  // Storage layout is owned by DSH; the callback's session must be present on disk.
  const files = await fs.readdir(path.join(h.directory, 'sessions'), {recursive: true});
  assert.ok(files.some(file => file.includes(run.results[0].result.session_id)));
});

test('incomplete model output records failure rather than a completed callback', async t => {
  const h = await harness(t, () => [{delta: {content: '截断'}}, {delta: {}, finish_reason: 'length'}]);
  await h.ctx.homeAssistant.engine.put(rule({actions: [{type: 'agent', prompt: '检查状态。'}]}), 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.ctx.homeAssistant.status().recent_runs[0]?.status === 'failed', 10000);
  assert.equal(h.ctx.homeAssistant.status().recent_runs[0].error, 'HA_AGENT_INCOMPLETE');
});

test('existing Agent callback acknowledges delivery and owning registration is disposable', async t => {
  const h = await harness(t);
  const existing = await h.ctx.agents.create({sessionId: 'existing-test', agentOptions: {provider: 'test-provider', model: 'test'}});
  t.after(() => existing.dispose());
  const release = h.ctx.homeAssistant.bindAgent('existing.agent', existing.agent, '检查事件。');
  await h.ctx.homeAssistant.engine.put(rule({actions: [{type: 'callback', name: 'existing.agent'}]}), 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.requests.length === 1);
  await existing.agent.whenIdle();
  await release();
  assert.deepEqual(h.ctx.homeAssistant.engine.bindings().callbacks, []);
});


test('disposing an existing DSH Agent removes its callback binding and permits a new generation', async t => {
  const h = await harness(t);
  const first = await h.ctx.agents.create({sessionId: 'bound-first', agentOptions: {provider: 'test-provider', model: 'test'}});
  h.ctx.homeAssistant.bindAgent('existing.agent', first.agent, '检查事件。');
  await h.ctx.homeAssistant.engine.put(rule({actions: [{type: 'callback', name: 'existing.agent'}]}), 0);
  await first.dispose();
  assert.deepEqual(h.ctx.homeAssistant.engine.bindings().callbacks, []);
  assert.deepEqual(h.ctx.homeAssistant.engine.bindings().unbound_rules, ['presence-light']);
  assert.throws(() => h.ctx.homeAssistant.bindAgent('stale.agent', first.agent, '不得接收事件。'));
  assert.deepEqual(h.ctx.homeAssistant.engine.bindings().callbacks, []);
  const second = await h.ctx.agents.create({sessionId: 'bound-second', agentOptions: {provider: 'test-provider', model: 'test'}});
  t.after(() => second.dispose());
  h.ctx.homeAssistant.bindAgent('existing.agent', second.agent, '检查新代次的事件。');
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.requests.length === 1);
  await second.agent.whenIdle();
  assert.ok(h.requests[0].messages.some(message => typeof message.content === 'string' && message.content.includes('新代次')));
});

test('unloading the plugin aborts and drains a pending DSH callback and releases its session', async t => {
  const pending = Promise.withResolvers();
  const h = await harness(t, () => pending.promise);
  t.after(() => pending.resolve([{delta: {content: 'late'}}, {delta: {}, finish_reason: 'stop'}]));
  const service = h.ctx.homeAssistant;
  await service.engine.put(rule({actions: [{type: 'agent', prompt: '检查状态。'}]}), 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.requests.length === 1);
  const callback = h.ctx.agents.list()[0];
  assert.ok(callback);
  await h.plugin.dispose();
  assert.equal(h.ctx.homeAssistant, undefined);
  assert.equal(h.ctx.tools.get('ha_control'), undefined);
  assert.deepEqual(h.ctx.agents.list(), []);
  assert.equal(h.ctx.sessions.get(callback.id), undefined);
  assert.equal(service.engine.health.queued, 0);
  assert.equal(service.store.snapshot().runs[0].status, 'failed');
  assert.equal(service.store.snapshot().runs[0].error, 'HA_CANCELLED');
  assert.deepEqual(h.ha.calls, []);
  pending.resolve([{delta: {content: 'late'}}, {delta: {}, finish_reason: 'stop'}]);
});

test('a pending DSH callback deadline is persisted as the deadline reason and releases its Agent', async t => {
  const pending = Promise.withResolvers();
  const h = await harness(t, () => pending.promise, {action_timeout_ms: 1000});
  t.after(() => pending.resolve([{delta: {content: 'late'}}, {delta: {}, finish_reason: 'stop'}]));
  const service = h.ctx.homeAssistant;
  await service.engine.put(rule({actions: [{type: 'agent', prompt: '检查状态。'}]}), 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => service.status().recent_runs[0]?.status === 'failed', 5000);
  assert.equal(service.status().recent_runs[0].error, 'HA_RULE_DEADLINE');
  assert.deepEqual(h.ctx.agents.list(), []);
  assert.deepEqual(h.ha.calls, []);
  pending.resolve([{delta: {content: 'late'}}, {delta: {}, finish_reason: 'stop'}]);
});


test('a model cannot execute global admin tools or acquire tools registered after callback setup', async t => {
  let unsafeCalls = 0, h;
  h = await harness(t, (_body, count) => {
    if (count === 1) {
      h.ctx.tools.register(defineTool({name: 'late_admin', description: 'Registered after callback setup', parameters: {},
        output: {schema: {type: 'json'}, render: () => []}, execute: () => { unsafeCalls++; return {}; }}));
      return toolCall('admin_shell', {});
    }
    if (count === 2) return toolCall('late_admin', {});
    return [{delta: {content: '拒绝未授权的工具。'}}, {delta: {}, finish_reason: 'stop'}];
  });
  h.ctx.tools.register(defineTool({name: 'admin_shell', description: 'Global privileged tool', parameters: {},
    output: {schema: {type: 'json'}, render: () => []}, execute: () => { unsafeCalls++; return {}; }}));
  await h.ctx.homeAssistant.engine.put(rule({actions: [{type: 'agent', prompt: '检查状态。'}]}), 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.ctx.homeAssistant.status().recent_runs[0]?.status === 'completed', 5000);
  assert.equal(h.requests.length, 3);
  assert.equal(unsafeCalls, 0);
  for (const request of h.requests)
    assert.deepEqual(request.tools.map(tool => tool.function.name).sort(), ['ha_control', 'ha_get_state', 'ha_run_logic', 'ha_search']);
  assert.deepEqual(h.ctx.agents.list(), []);
});

test('the callback tool budget denies further HA side effects while preserving the first allowed read', async t => {
  const h = await harness(t, (_body, count) => {
    if (count === 1) return toolCall('ha_get_state', {entity_id: 'light.desk'});
    if (count === 2) return toolCall('ha_control', {entity_id: 'light.desk', action: 'turn_on'});
    return [{delta: {content: '已达到工具调用上限，未开灯。'}}, {delta: {}, finish_reason: 'stop'}];
  }, {agent: {provider: 'test-provider', model: 'test', max_tool_calls: 1}});
  await h.ctx.homeAssistant.engine.put(rule({actions: [{type: 'agent', prompt: '检查状态。'}]}), 0);
  h.ha.broadcast(h.ha.stateEvent('binary_sensor.presence', 'on'));
  await until(() => h.ctx.homeAssistant.status().recent_runs[0]?.status === 'completed', 5000);
  assert.equal(h.requests.length, 3);
  assert.equal(h.ha.gets.filter(id => id === 'light.desk').length, 1);
  assert.deepEqual(h.ha.calls, []);
  assert.ok(h.requests[2].messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('HA_AGENT_TOOL_BUDGET')));
  assert.deepEqual(h.ctx.agents.list(), []);
});

test('native automation tools mount in real DSH with simulated HA and no speaker transport',async t=>{
  const initial=await fakeHA(t);
  const h=await harness(t,undefined,{ha_backend:'simulated',native_automations:{allow_enable:false},xiaomi_configuration:true,
    simulated_states:[...initial.states.values()]});
  assert.equal(h.ctx.tools.definitions().length,18);
  const native={id:'nomi_desk',alias:'Desk presence',initial_state:false,mode:'single',
    triggers:[{trigger:'state',entity_id:'binary_sensor.presence',to:'on'}],conditions:[],
    actions:[{alias:'desk_on',action:'light.turn_on',target:{entity_id:'light.desk'}}]};
  const exec={signal:new AbortController().signal};
  const saved=await h.ctx.tools.get('ha_automation_put').execute({config:native,expected_revision:0},exec);
  assert.equal(saved.revision,1);
  const renamed=await h.ctx.tools.get('ha_automation_patch').execute({id:native.id,expected_revision:1,changes:[{op:'rename',name:'Updated desk rule'}]},exec);
  assert.equal(renamed.revision,2);assert.equal(renamed.config.initial_state,false);
  assert.equal(h.ctx.homeAssistant.client.calls.length,0);assert.equal(h.requests.length,0);
  assert.equal(h.ctx.get('homeVoice'),undefined);
});

test('HA-exclusive mode hides legacy DSH rule writers and never dispatches native events locally',async t=>{
  const initial=await fakeHA(t);
  const h=await harness(t,undefined,{ha_backend:'simulated',native_automations:{allow_enable:false,exclusive:true},
    simulated_states:[...initial.states.values()]});
  assert.equal(h.ctx.tools.get('ha_rule_put'),undefined);
  assert.ok(h.ctx.tools.get('ha_automation_put'));
  h.ctx.homeAssistant.client.setState('binary_sensor.presence','on');
  assert.equal(h.ctx.homeAssistant.client.calls.length,0);
  assert.equal(h.ctx.get('homeVoice'),undefined);
});

test('DSH Agent loop creates a native disabled HA automation through its registered tool',async t=>{
  const initial=await fakeHA(t);
  const config={id:'nomi_agent_rule',alias:'Agent-created hall rule',initial_state:false,mode:'single',
    triggers:[{trigger:'state',entity_id:'binary_sensor.presence',to:'on'}],conditions:[],
    actions:[{alias:'desk_on',action:'light.turn_on',target:{entity_id:'light.desk'}}]};
  const h=await harness(t,body=>body.messages.some(m=>m.role==='tool')
    ? [{delta:{content:'已保存，保持禁用。'}},{delta:{},finish_reason:'stop'}]
    : toolCall('ha_automation_put',{config,expected_revision:0}),
    {ha_backend:'simulated',native_automations:{allow_enable:false,exclusive:true},simulated_states:[...initial.states.values()]});
  const owner=await h.ctx.agents.create({sessionId:'native-owner',agentOptions:{provider:'test-provider',model:'test'}});
  owner.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'创建有人开灯自动化，但保持关闭。'}]}));
  await owner.agent.whenIdle();await owner.dispose();
  assert.equal(h.ctx.homeAssistant.nativeAutomations.list().length,1);
  assert.equal(h.ctx.homeAssistant.client.automations.get(config.id).initial_state,false);
  assert.equal(h.ctx.homeAssistant.client.calls.length,0);assert.equal(h.ctx.get('homeVoice'),undefined);
});

test('DSH uses a MIPS power edge to run the enrolled Go control and persist its device receipt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-miot-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const directory = path.join(root, '.local');
  await fs.mkdir(directory);
  const fixture = path.join(directory, 'light.json'), push = path.join(directory, 'push.json');
  const control = path.join(directory, 'control'), watch = path.join(directory, 'watch');
  const before = {power: false, brightness: 50, kelvin: 3000};
  await fs.writeFile(fixture, JSON.stringify(before), {mode: 0o600});
  await fs.writeFile(control, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), get = key => args[args.indexOf(key) + 1];
const file = get('-config'), current = JSON.parse(fs.readFileSync(file));
if (get('-expected-light') !== 'fixture.light') process.exit(1);
const emit = row => console.log(JSON.stringify(row));
if (get('-mode') === 'read') emit({phase:'readback', ...current});
else {
  if (get('-property') !== 'power' || get('-value') !== 'false' || !current.power) process.exit(2);
  fs.writeFileSync(file, JSON.stringify({...current, power:false}));
  if (fs.existsSync(file + '.omit-ack')) emit({phase:'write-confirmed', piid:1, value:false});
  else {
    emit({phase:'write-ack', piid:1, code:1});
    emit({phase:'write-confirmed', piid:1, code:1, value:false});
  }
}
`, {mode: 0o700});
  await fs.writeFile(watch, `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(push)};
console.log(JSON.stringify({phase:'subscribed', source:'local-mips'}));
let sent = false;
setInterval(() => {
  if (!sent && fs.existsSync(file)) {
    sent = true;
    const push = JSON.parse(fs.readFileSync(file));
    console.log(JSON.stringify({...push, at:new Date().toISOString()}));
  }
}, 20);
`, {mode: 0o700});
  const h = await harness(t, undefined, {ha_backend: 'miot_lan', agent: undefined, native_automations: undefined,
    miot_lan: {control_binary: control, watch_binary: watch, gateway_path: fixture, identity_path: fixture},
    entities: [{entity_id: 'light.test', local_verified: true, control_allowed: true, actions: ['turn_off'],
      miot_did: 'fixture.light', miot_config_path: fixture}]});
  assert.equal(h.ctx.homeAssistant.controls.search()[0].miot_config_path, undefined);
  await h.ctx.tools.get('ha_rule_put').execute({expected_revision: 0, rule: {
    id: 'miot-power', name: 'Turn the enrolled light off on a rising edge', enabled: true,
    trigger: {type: 'state', entity_id: 'light.test', from: 'off', to: 'on'},
    conditions: [], actions: [{type: 'control', entity_id: 'light.test', action: 'turn_off'}],
  }}, {signal: new AbortController().signal});
  await fs.writeFile(fixture, JSON.stringify({...before, power: true}));
  await fs.writeFile(push, JSON.stringify({phase: 'device-property', source: 'local-mips', did: 'fixture.light', siid: 2, piid: 1, value: true}));
  const service = h.ctx.homeAssistant;
  await until(() => service.status().recent_runs[0]?.status === 'completed');
  const [run] = service.status().recent_runs;
  assert.equal(run.event.from, 'off');
  assert.equal(run.event.to, 'on');
  assert.deepEqual(run.results[0].result.receipts, [{siid: 2, piid: 1, code: 1, value: false, readback_confirmed: true}]);
  assert.equal(run.results[0].result.state.state, 'off');
  await fs.writeFile(fixture, JSON.stringify({...before, power: true}));
  await fs.writeFile(fixture + '.omit-ack', '');
  const missingAck = await h.ctx.tools.get('ha_control').execute({entity_id: 'light.test', action: 'turn_off'},
    {signal: new AbortController().signal});
  assert.equal(missingAck.status, 'uncertain');
  assert.deepEqual(missingAck.receipts, []);
  assert.deepEqual(h.ha.calls, []);
});
