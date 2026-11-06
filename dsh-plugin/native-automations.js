/** Native HA automations: HA owns triggers/execution; DSH owns revisioned edits. */
import {createHash} from 'node:crypto';
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const ID = /^nomi_[a-z0-9_]{1,100}$/;
const SERVICES = new Set(['light.turn_on','light.turn_off','switch.turn_on','switch.turn_off','fan.turn_on','fan.turn_off',
  'climate.turn_on','climate.turn_off','cover.open_cover','cover.close_cover','input_select.select_option',
  'nomi_automation.configure_light']);
const fail = code => { throw new Error(code); };

export function validateNative(config, entities, {allowEnable = false} = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !ID.test(config.id ?? '')) fail('HA_NATIVE_INVALID_ID');
  if (typeof config.alias !== 'string' || !config.alias.trim() || config.alias.length > 200) fail('HA_NATIVE_INVALID_NAME');
  const keys = ['id','alias','description','initial_state','mode','max','triggers','conditions','actions','trace'];
  if (Object.keys(config).some(k => !keys.includes(k)) || !Array.isArray(config.triggers) || !config.triggers.length
    || !Array.isArray(config.actions) || !config.actions.length || !Array.isArray(config.conditions ?? [])) fail('HA_NATIVE_INVALID_CONFIG');
  if (typeof config.initial_state !== 'boolean') fail('HA_NATIVE_INITIAL_STATE_REQUIRED');
  if (config.initial_state !== false && !allowEnable) fail('HA_NATIVE_ENABLE_LOCKED');
  if (!['single','restart','queued','parallel'].includes(config.mode ?? 'single')) fail('HA_NATIVE_INVALID_MODE');
  if (Buffer.byteLength(JSON.stringify(config)) > 1024 * 1024) fail('HA_NATIVE_TOO_LARGE');
  function checkEntity(id, write = false) {
    if (typeof id !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(id)) fail('HA_NATIVE_INVALID_ENTITY');
    const entry = entities.get(id);
    if (!entry || entry.local_verified !== true || write && entry.control_allowed !== true) fail('HA_NATIVE_ENTITY_DENIED');
  }
  function condition(c) {
    if (!c || typeof c !== 'object') fail('HA_NATIVE_INVALID_CONDITION');
    if (['and','or','not'].includes(c.condition)) { c.conditions.forEach(condition); return; }
    if (['state','numeric_state'].includes(c.condition)) { [c.entity_id].flat().forEach(id=>checkEntity(id)); return; }
    if (c.condition === 'time' || c.condition === 'trigger') return;
    if (c.condition === 'template') {
      const expression = c.value_template;
      if (typeof expression !== 'string' || expression.includes('{%') || /__|\battribute\b|\bconfig\b/.test(expression)) fail('HA_NATIVE_TEMPLATE_DENIED');
      // Generated predicates may read only enrolled, literal entity IDs.
      const words=expression.replace(/['"][^'"]*['"]/g,'').match(/[A-Za-z_]+/g) ?? [];
      const permitted=new Set(['states','is_state','not','in','and','or','float','trigger','event','data','old_state','new_state','state','is','none','true','false']);
      if(words.some(w=>!permitted.has(w))) fail('HA_NATIVE_TEMPLATE_DENIED');
      for (const m of expression.matchAll(/(?:states|is_state)\(\s*['"]([^'"]+)['"]/g)) checkEntity(m[1]);
      if (!expression.includes('states(') && !expression.includes('is_state(')) fail('HA_NATIVE_TEMPLATE_DENIED');
      return;
    }
    fail('HA_NATIVE_CONDITION_DENIED');
  }
  function actions(list, depth=0) {
    if (!Array.isArray(list) || depth > 64) fail('HA_NATIVE_ACTION_DEPTH');
    for (const a of list) {
      if (Object.keys(a).some(k => !['alias','action','target','data','parallel','sequence','if','then','else','choose','default','conditions','delay','stop','error','condition','entity_id','state','value_template','above','below','attribute'].includes(k))) fail('HA_NATIVE_ACTION_FIELDS');
      if (a.action) {
        if (!SERVICES.has(a.action) || typeof a.action !== 'string') fail('HA_NATIVE_SERVICE_DENIED');
        const ids = a.target?.entity_id ?? a.data?.entity_id;
        if (!ids || a.target && Object.keys(a.target).some(k=>k!=='entity_id')) fail('HA_NATIVE_TARGET_REQUIRED');
        [ids].flat().forEach(id=>checkEntity(id,true));
        if (a.data?.entity_id) [a.data.entity_id].flat().forEach(id=>checkEntity(id,true));
        const allowed = a.action === 'nomi_automation.configure_light' ? ['entity_id','brightness_pct','color_temp_kelvin']
          : a.action === 'input_select.select_option' ? ['entity_id','option']
          : a.action === 'light.turn_on' ? ['entity_id','brightness_pct','color_temp_kelvin','brightness','transition'] : ['entity_id'];
        if (Object.keys(a.data ?? {}).some(k=>!allowed.includes(k))) fail('HA_NATIVE_SERVICE_FIELDS_DENIED');
        const requested = a.action==='nomi_automation.configure_light' ?
          [...(a.data?.brightness_pct!==undefined?['set_brightness']:[]),...(a.data?.color_temp_kelvin!==undefined?['set_color_temperature']:[])]
          : a.action==='light.turn_on' && (a.data?.brightness_pct!==undefined || a.data?.brightness!==undefined || a.data?.color_temp_kelvin!==undefined) ?
            [...(a.data?.brightness_pct!==undefined || a.data?.brightness!==undefined?['set_brightness']:[]),...(a.data?.color_temp_kelvin!==undefined?['set_color_temperature']:[])] : [a.action.split('.')[1]];
        if(a.action==='nomi_automation.configure_light' && !requested.length)fail('HA_NATIVE_LIGHT_VALUE_REQUIRED');
        if(a.data?.brightness_pct!==undefined && (!Number.isFinite(a.data.brightness_pct)||a.data.brightness_pct<0||a.data.brightness_pct>100
          || a.action==='nomi_automation.configure_light' && a.data.brightness_pct===0)) fail('HA_NATIVE_BRIGHTNESS_RANGE');
        if(a.data?.color_temp_kelvin!==undefined && (!Number.isInteger(a.data.color_temp_kelvin)||a.data.color_temp_kelvin<1000||a.data.color_temp_kelvin>20000))fail('HA_NATIVE_KELVIN_RANGE');
        for(const id of [ids].flat()) {
          if(!id.startsWith((a.action==='nomi_automation.configure_light'?'light':a.action.split('.')[0])+'.'))fail('HA_NATIVE_DOMAIN_MISMATCH');
          const entry=entities.get(id);
          if(entry.actions && requested.some(action=>!entry.actions.includes(action)))fail('HA_NATIVE_ACTION_NOT_ENROLLED');
        }

        if (Object.values(a.data ?? {}).some(v=> typeof v === 'string' && /{{|{%/.test(v))) fail('HA_NATIVE_DYNAMIC_ACTION_DENIED');
      } else if (a.parallel) { for(const branch of a.parallel) actions(branch.sequence ?? [branch],depth+1); }
      else if (a.if) { a.if.forEach(condition); actions(a.then ?? [],depth+1); actions(a.else ?? [],depth+1); }
      else if (a.choose) { for(const branch of a.choose) { branch.conditions.forEach(condition); actions(branch.sequence,depth+1); } actions(a.default ?? [],depth+1); }
      else if (a.delay !== undefined) { if (!Number.isFinite(a.delay?.seconds) || a.delay.seconds < 0 || a.delay.seconds > 86400) fail('HA_NATIVE_INVALID_DELAY'); }
      else if (a.condition) condition(a);
      else if (a.stop === undefined) fail('HA_NATIVE_ACTION_DENIED');
    }
  }
  for (const t of config.triggers) {
    if (!['state','numeric_state','event','time','homeassistant'].includes(t.trigger)) fail('HA_NATIVE_TRIGGER_DENIED');
    if (t.entity_id) [t.entity_id].flat().forEach(id=>checkEntity(id));
    if (t.trigger === 'event' && !['nomi_mode','state_changed'].includes(t.event_type)) fail('HA_NATIVE_EVENT_DENIED');
    if (t.event_type === 'state_changed') checkEntity(t.event_data?.entity_id);
  }
  (config.conditions ?? []).forEach(condition); actions(config.actions);
  return structuredClone(config);
}

export class NativeAutomations {
  constructor(client, store, entities, settings = {}) {
    this.client=client; this.store=store; this.entities=entities; this.settings=settings; this.tail=Promise.resolve();
  }
  serial(fn) { const work=this.tail.catch(()=>{}).then(fn);this.tail=work.catch(()=>{});return work; }
  list() { return (this.store.snapshot().native_automations ?? []).map(({history,...row})=>row); }
  async get(id, signal) {
    if (!ID.test(id)) fail('HA_NATIVE_INVALID_ID');
    const row=this.list().find(r=>r.id===id);if(!row) fail('HA_NATIVE_NOT_MANAGED');
    const actual=await this.client.automationConfig(id,undefined,signal);
    return {...row,drift:fingerprint(actual)!==row.hash,actual};
  }
  preview(config) {
    const parsed=validateNative(config,this.entities,{allowEnable:this.settings.allow_enable===true});
    const current=this.list().find(r=>r.id===parsed.id);
    return {valid:true,id:parsed.id,enabled:parsed.initial_state,hash:fingerprint(parsed),
      unchanged:current?.hash===fingerprint(parsed),current_revision:current?.revision??0,
      effects:'validation_only_no_config_or_device_writes'};
  }
  put(config, expectedRevision, {signal}={}) {
    config=validateNative(config,this.entities,{allowEnable:this.settings.allow_enable===true});
    return this.serial(()=>this.save(config,expectedRevision,signal));
  }
  async save(config, expectedRevision, signal) {
    const old=this.list().find(r=>r.id===config.id);
    if (!Number.isInteger(expectedRevision) || expectedRevision<0 || (old?.revision ?? 0)!==expectedRevision) fail('HA_NATIVE_REVISION_CONFLICT');
    if (this.store.snapshot().native_pending?.[config.id]) fail('HA_NATIVE_PENDING_RECONCILE_REQUIRED');
    let actual;
    try { actual=await this.client.automationConfig(config.id,undefined,signal); }
    catch(error) { if(error.message!=='HA_HTTP_404') throw error; }
    if (old ? !actual || fingerprint(actual)!==old.hash : actual) fail('HA_NATIVE_REMOTE_CONFLICT');
    const intent={id:config.id,config,expected_revision:expectedRevision,at:new Date().toISOString()};
    await this.store.transact(data=>{(data.native_pending ??= {})[config.id]=intent;});
    try {
      await this.client.automationConfig(config.id,config,signal);
      const read=await this.client.automationConfig(config.id,undefined,signal);
      if(fingerprint(read)!==fingerprint(config)) fail('HA_NATIVE_READBACK_MISMATCH');
      return await this.commit(intent);
    } catch(error) {
      // Keep uncertain writes pending. A subsequent get/reconcile reads, never replays.
      if(/^HA_HTTP_4\d\d$/.test(error.message)) await this.store.transact(d=>{delete d.native_pending[config.id];});
      throw error;
    }
  }
  commit(intent) {
    return this.store.transact(data=>{
      const rows=data.native_automations ??= [], index=rows.findIndex(r=>r.id===intent.id), old=rows[index];
      const row={id:intent.id,revision:intent.expected_revision+1,hash:fingerprint(intent.config),config:intent.config,
        updated_at:new Date().toISOString(),history:[...(old?.history ?? []),...(old?[{revision:old.revision,config:old.config}]:[])].slice(-10)};
      if(index<0) rows.push(row);else rows[index]=row;
      delete data.native_pending[intent.id];return structuredClone(row);
    });
  }
  reconcile(id, signal) {
    return this.serial(async()=>{
      const pending=this.store.snapshot().native_pending?.[id];if(!pending) return this.get(id,signal);
      if(pending.operation==='delete') {
        try { await this.client.automationConfig(id,undefined,signal); }
        catch(error) {if(error.message==='HA_HTTP_404')return this.commitDelete(id);throw error;}
        fail('HA_NATIVE_DELETE_NOT_CONFIRMED');
      }
      const actual=await this.client.automationConfig(id,undefined,signal);
      if(fingerprint(actual)!==fingerprint(pending.config)) fail('HA_NATIVE_REMOTE_CONFLICT');
      return this.commit(pending);
    });
  }
  patch(id, expectedRevision, changes, options={}) {
    return this.serial(async()=>{
      const row=this.list().find(r=>r.id===id);if(!row) fail('HA_NATIVE_NOT_MANAGED');
      const config=structuredClone(row.config);
      if(!Array.isArray(changes)||!changes.length||changes.length>20) fail('HA_NATIVE_INVALID_PATCH');
      const findAll=(list,alias,result=[])=>{
        for(let i=0;i<list.length;i++) { const a=list[i];if(a.alias===alias)result.push({list,index:i,action:a});
          for(const sub of [a.then,a.else,a.default,...(a.choose??[]).map(b=>b.sequence),...(a.parallel??[]).map(b=>b.sequence??[b])].filter(Boolean)) findAll(sub,alias,result);}
        return result;
      };
      for(const change of changes) {
        if(change.op==='rename') config.alias=change.name;
        else if(change.op==='set_enabled') config.initial_state=change.enabled;
        else if(change.op==='append_action') config.actions.push(structuredClone(change.action));
        else if(['add_target','remove_action'].includes(change.op)) {
          const matches=findAll(config.actions,change.action_alias);if(!matches.length) fail('HA_NATIVE_ACTION_NOT_FOUND');
          // A compiled DAG can contain the same logical action in several trigger branches.
          // Edit every copy; reverse order keeps indices stable when removing siblings.
          for(const found of matches.reverse()) {
            if(change.op==='remove_action')found.list.splice(found.index,1);
            else {const copy=structuredClone(found.action);copy.alias=change.new_alias;
              if(typeof copy.alias!=='string'||!copy.alias)fail('HA_NATIVE_ACTION_ALIAS_REQUIRED');
              if(copy.target)copy.target.entity_id=change.entity_id;else if(copy.data)copy.data.entity_id=change.entity_id;
              else fail('HA_NATIVE_NOT_DEVICE_ACTION');
              if(!found.list.some(a=>fingerprint({...a,alias:null})===fingerprint({...copy,alias:null})))found.list.splice(found.index+1,0,copy);
            }
          }
        } else fail('HA_NATIVE_PATCH_DENIED');
      }
      validateNative(config,this.entities,{allowEnable:this.settings.allow_enable===true});
      return this.save(config,expectedRevision,options.signal);
    });
  }
  rollback(id, revision, targetRevision, options={}) {
    const row=this.store.snapshot().native_automations?.find(r=>r.id===id);
    const target=row?.history.find(r=>r.revision===targetRevision);if(!target)fail('HA_NATIVE_HISTORY_NOT_FOUND');
    return this.put({...target.config,initial_state:false},revision,options);
  }
  commitDelete(id) {
    return this.store.transact(data=>{
      data.native_automations=data.native_automations.filter(r=>r.id!==id);
      delete data.native_pending[id];return {deleted:true,id};
    });
  }
  remove(id, expectedRevision, {signal}={}) {
    return this.serial(async()=>{
      const row=await this.get(id,signal);if(row.revision!==expectedRevision)fail('HA_NATIVE_REVISION_CONFLICT');
      if(row.drift)fail('HA_NATIVE_REMOTE_CONFLICT');
      if(this.store.snapshot().native_pending?.[id]) fail('HA_NATIVE_PENDING_RECONCILE_REQUIRED');
      await this.store.transact(data=>{(data.native_pending??={})[id]={id,operation:'delete',expected_revision:expectedRevision,at:new Date().toISOString()};});
      try { await this.client.deleteAutomation(id,signal); }
      catch(error) {
        if(/^HA_HTTP_4\d\d$/.test(error.message))await this.store.transact(data=>{delete data.native_pending[id];});
        throw error;
      }
      try { await this.client.automationConfig(id,undefined,signal);fail('HA_NATIVE_DELETE_UNCONFIRMED'); }
      catch(e) {if(e.message!=='HA_HTTP_404')throw e;}
      return this.commitDelete(id);
    });
  }
}
