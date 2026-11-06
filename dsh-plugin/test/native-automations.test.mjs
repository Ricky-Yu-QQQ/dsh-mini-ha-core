import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeAutomations,validateNative} from '../native-automations.js';
import {RuleStore} from '../store.js';
import {SimulatedHA} from '../simulated.js';

const config=()=>({id:'nomi_hall',alias:'Hall lighting',initial_state:false,mode:'single',
  triggers:[{trigger:'state',entity_id:'binary_sensor.hall',to:'on'}],conditions:[],
  actions:[{alias:'hall_on',action:'light.turn_on',target:{entity_id:'light.hall'}}]});
async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nomi-native-'));
  const store=new RuleStore(path.join(root,'.local'));await store.open();
  const entities=new Map(['binary_sensor.hall','light.hall','light.strip'].map(entity_id=>[entity_id,{entity_id,local_verified:true,control_allowed:true}]));
  const client=new SimulatedHA({entities:[...entities.values()],simulated_states:[...entities.keys()].map(entity_id=>({entity_id,state:'off',attributes:{}}))});client.start();
  const manager=new NativeAutomations(client,store,entities);
  t.after(async()=>{await client.close();await store.close();await fs.rm(root,{recursive:true,force:true});});
  return {manager,client,store,entities};
}
test('native create/update/rollback/delete stays disabled and performs zero device or audio calls',async t=>{
 const {manager:m,client}=await setup(t);const created=await m.put(config(),0);
 assert.equal(created.revision,1);assert.equal(client.calls.length,0);
 await m.patch('nomi_hall',1,[{op:'rename',name:'Hall new'}]);
 const restored=await m.rollback('nomi_hall',2,1);assert.equal(restored.revision,3);assert.equal(restored.config.alias,'Hall lighting');
 assert.equal((await m.get('nomi_hall')).drift,false);assert.equal((await m.remove('nomi_hall',3)).deleted,true);
 assert.equal(m.list().length,0);assert.equal(client.calls.length,0);
});
test('add target retains trigger and repeated addition does not duplicate actions',async t=>{
 const {manager:m}=await setup(t);await m.put(config(),0);
 const change={op:'add_target',action_alias:'hall_on',entity_id:'light.strip',new_alias:'strip_on'};
 const result=await m.patch('nomi_hall',1,[change]);assert.deepEqual(result.config.triggers,config().triggers);
 assert.equal(result.config.actions.length,2);
 const twice=await m.patch('nomi_hall',2,[change]);assert.equal(twice.config.actions.length,2);
});
test('concurrent stale edits cannot overwrite the winner',async t=>{
 const {manager:m}=await setup(t);await m.put(config(),0);
 const r=await Promise.allSettled([m.put({...config(),alias:'A'},1),m.put({...config(),alias:'B'},1)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.match(r.find(x=>x.status==='rejected').reason.message,/REVISION_CONFLICT/);
});
test('HA UI edits are detected and never silently overwritten',async t=>{
 const {manager:m,client}=await setup(t);await m.put(config(),0);
 client.automations.get('nomi_hall').alias='Edited in HA';assert.equal((await m.get('nomi_hall')).drift,true);
 await assert.rejects(m.put(config(),1),/REMOTE_CONFLICT/);
});
test('unknown save remains durable and reconcile only reads',async t=>{
 const {manager:m,client,store}=await setup(t);const original=client.automationConfig.bind(client);let writes=0;
 client.automationConfig=async(id,body,signal)=>{if(body){writes++;await original(id,body,signal);throw new Error('HA_TRANSPORT_UNCERTAIN');}return original(id,body,signal);};
 await assert.rejects(m.put(config(),0),/UNCERTAIN/);assert.ok(store.snapshot().native_pending.nomi_hall);
 const recovered=await m.reconcile('nomi_hall');assert.equal(recovered.revision,1);assert.equal(writes,1);
});
test('enable lock, unenrolled entities and unsafe services fail before dispatch',async t=>{
 const {manager:m,client,entities}=await setup(t);
 assert.throws(()=>m.put({...config(),initial_state:true},0),/ENABLE_LOCKED/);
 assert.throws(()=>m.put({...config(),actions:[{action:'light.turn_on',target:{entity_id:'light.bedroom'}}]},0),/ENTITY_DENIED/);
 assert.throws(()=>validateNative({...config(),actions:[{action:'shell_command.test',target:{entity_id:'light.hall'}}]},entities),/SERVICE_DENIED/);
 assert.equal(client.automations.size,0);
});

test('off light configuration uses HA extension and preserves off in simulated backend',async t=>{
 const {client,entities}=await setup(t);
 const {Controls}=await import('../controls.js');
 client.states.get('light.hall').attributes={supported_color_modes:['color_temp'],min_color_temp_kelvin:2700,max_color_temp_kelvin:6500};
 const controls=new Controls(client,entities);
 const receipt=await controls.configure({entity_id:'light.hall',brightness_pct:20,color_temp_kelvin:3000});
 assert.equal(receipt.status,'confirmed');assert.equal((await client.state('light.hall')).state,'off');
 assert.equal(client.calls.length,1);assert.equal(client.calls[0].action,'configure_light');
 assert.throws(()=>controls.configure({entity_id:'light.hall',brightness_pct:0}),/BRIGHTNESS_RANGE/);
});

test('adding a light updates every trigger branch that shares the action alias',async t=>{
 const {manager:m}=await setup(t),base=config(), action=base.actions[0];
 base.actions=[{choose:[{conditions:[{condition:'trigger',id:'a'}],sequence:[action]},
   {conditions:[{condition:'trigger',id:'b'}],sequence:[structuredClone(action)]}]}];
 await m.put(base,0);const saved=await m.patch(base.id,1,[{op:'add_target',action_alias:'hall_on',entity_id:'light.strip',new_alias:'strip_on'}]);
 for(const branch of saved.config.actions[0].choose)assert.equal(branch.sequence.length,2);
});

test('preview and rejected data override never write configurations or devices',async t=>{
 const {manager:m,client}=await setup(t);
 assert.equal(m.preview(config()).effects,'validation_only_no_config_or_device_writes');
 assert.throws(()=>m.put({...config(),actions:[{action:'light.turn_on',target:{entity_id:'light.hall'},data:{entity_id:'light.bedroom'}}]},0),/ENTITY_DENIED/);
 assert.equal(client.automations.size,0);assert.equal(client.calls.length,0);
});

test('uncertain deletion is recorded and reconciled without resending',async t=>{
 const {manager:m,client,store}=await setup(t);await m.put(config(),0);let deletes=0;
 const original=client.deleteAutomation.bind(client);client.deleteAutomation=async id=>{deletes++;await original(id);throw new Error('HA_TRANSPORT_UNCERTAIN');};
 await assert.rejects(m.remove('nomi_hall',1),/UNCERTAIN/);
 assert.equal(store.snapshot().native_pending.nomi_hall.operation,'delete');
 assert.equal((await m.reconcile('nomi_hall')).deleted,true);assert.equal(deletes,1);assert.equal(m.list().length,0);
});
