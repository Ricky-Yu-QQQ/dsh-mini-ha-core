/** Explicit native-config maintenance. Never starts the event engine, Agent, or audio. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {HAClient} from './client.js';
import {SimulatedHA} from './simulated.js';
import {RuleStore} from './store.js';
import {validateSettings} from './model.js';
import {NativeAutomations,validateNative,fingerprint} from './native-automations.js';

export async function run(settings, command, input) {
  if (!settings.native_automations) throw new Error('HA_NATIVE_NOT_CONFIGURED');
  const entities=validateSettings(settings), store=new RuleStore(settings.state);
  const client=settings.ha_backend==='simulated'?new SimulatedHA(settings):new HAClient(settings);
  await store.open();
  const manager=new NativeAutomations(client,store,entities,settings.native_automations);
  try {
    if(command==='list')return manager.list();
    if(command==='get')return await manager.get(input.id);
    if(command==='put')return await manager.put(input.config,input.expected_revision);
    if(command==='patch')return await manager.patch(input.id,input.expected_revision,input.changes);
    if(command==='delete')return await manager.remove(input.id,input.expected_revision);
    if(command==='reconcile')return await manager.reconcile(input.id);
    if(command==='rollback')return await manager.rollback(input.id,input.expected_revision,input.target_revision);
    if(command==='import') {
      if(input.all_disabled!==true || input.automations.some(c=>c.initial_state!==false))throw new Error('HA_NATIVE_IMPORT_MUST_BE_DISABLED');
      // Validate the whole batch before its first configuration write.
      input.automations.forEach(c=>validateNative(c,entities));
      const results=[];
      for(const config of input.automations) {
        const existing=manager.list().find(r=>r.id===config.id);
        if(existing) {
          const actual=await manager.get(config.id);if(actual.drift)throw new Error('HA_NATIVE_REMOTE_CONFLICT');
          if(existing.hash===fingerprint(config)) results.push({id:config.id,revision:existing.revision,status:'unchanged'});
          else {const updated=await manager.put(config,existing.revision);results.push({id:config.id,revision:updated.revision,status:'updated_disabled'});}
          continue;
        }
        const row=await manager.put(config,0);results.push({id:row.id,revision:row.revision,status:'imported_disabled'});
      }
      return results;
    }
    throw new Error('HA_NATIVE_UNKNOWN_COMMAND');
  } finally {await manager.tail;await client.close();await store.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, ,settingsPath,command,inputPath]=process.argv;
  const settings=JSON.parse(await fs.readFile(settingsPath,'utf8'));
  const input=inputPath?JSON.parse(await fs.readFile(inputPath,'utf8')):{};
  console.log(JSON.stringify(await run(settings,command,input),null,2));
}
