import {setTimeout as delay} from 'node:timers/promises';
import {enrolled, validateOperation} from './model.js';

export class Controls {
  constructor(client, entities, options = {}) {
    this.client = client; this.entities = entities;
    this.pollMs = options.pollMs ?? 300; this.attempts = options.attempts ?? 8;
    this.tails = new Map();
  }
  async get(id, signal) {
    enrolled(this.entities, id);
    const state = await this.client.state(id, signal);
    if (state?.entity_id !== id) throw new Error('HA_STATE_ID_MISMATCH');
    if (typeof state.state !== 'string' || !state.attributes || typeof state.attributes !== 'object'
      || Array.isArray(state.attributes)) throw new Error('HA_INVALID_STATE');
    return state;
  }
  search(query = '') {
    if (typeof query !== 'string' || query.length > 200) throw new Error('HA_INVALID_QUERY');
    const term = query.trim().toLowerCase();
    return [...this.entities.values()].filter(entity => JSON.stringify([entity.entity_id, entity.name,
      entity.area, entity.aliases]).toLowerCase().includes(term)).slice(0, 100);
  }
  // Serialize commands to the same entity so readback cannot confirm another caller's action.
  control(operation, signal) {
    validateOperation(operation, this.entities);
    operation = structuredClone(operation);
    const previous = this.tails.get(operation.entity_id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.perform(operation, signal));
    this.tails.set(operation.entity_id, work);
    work.finally(() => { if (this.tails.get(operation.entity_id) === work) this.tails.delete(operation.entity_id); }).catch(() => {});
    return work;
  }
  async perform(operation, signal) {
    signal?.throwIfAborted();
    const {entity_id: id, action, value} = operation, domain = id.split('.')[0];
    const before = await this.get(id, signal);
    if (['unknown', 'unavailable'].includes(before.state)) throw new Error('HA_ENTITY_UNAVAILABLE');
    const attributes = before.attributes ?? {};
    let service = action, data = {entity_id: id}, confirm;
    if (action === 'set_brightness') {
      if (!(attributes.supported_color_modes ?? []).some(mode => ['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white'].includes(mode)))
        throw new Error('HA_BRIGHTNESS_UNSUPPORTED');
      service = 'turn_on'; data.brightness_pct = value;
      confirm = state => value === 0 ? state.state === 'off' : state.state === 'on'
        && Math.abs(state.attributes?.brightness - value * 255 / 100) <= 3;
    } else if (action === 'set_color_temperature') {
      if (!(attributes.supported_color_modes ?? []).includes('color_temp')) throw new Error('HA_COLOR_TEMPERATURE_UNSUPPORTED');
      if (!Number.isFinite(attributes.min_color_temp_kelvin) || !Number.isFinite(attributes.max_color_temp_kelvin)
        || value < attributes.min_color_temp_kelvin || value > attributes.max_color_temp_kelvin) throw new Error('HA_DEVICE_KELVIN_RANGE');
      service = 'turn_on'; data.color_temp_kelvin = value;
      confirm = state => state.state === 'on' && Math.abs(state.attributes?.color_temp_kelvin - value) <= 100;
    } else confirm = state => action === 'turn_off' ? state.state === 'off' : domain === 'climate'
      ? !['off', 'unknown', 'unavailable'].includes(state.state) : state.state === 'on';
    if (this.client.writeLight) return this.client.writeLight(operation, before, signal);
    if (confirm(before)) return {status: 'confirmed', unchanged: true, requested: operation, state: before};
    signal?.throwIfAborted();
    try { await this.client.request(`/api/services/${domain}/${service}`, data, signal); }
    catch (error) {
      if (/^HA_HTTP_4\d\d$/.test(error.message)) throw error;
      return {status: 'uncertain', requested: operation, reason: 'service_result_unknown_no_retry'};
    }
    let state;
    for (let i = 0; i < this.attempts; i++) {
      try { state = await this.get(id, signal); }
      catch { return {status: 'unconfirmed', requested: operation, reason: 'readback_failed'}; }
      if (confirm(state)) return {status: 'confirmed', requested: operation, state};
      if (i + 1 < this.attempts) await delay(this.pollMs, undefined, {signal});
    }
    return {status: 'unconfirmed', requested: operation, state};
  }
  configure(parameters, signal) {
    const {entity_id:id,brightness_pct,color_temp_kelvin}=parameters;
    if(Object.keys(parameters).some(k=>!['entity_id','brightness_pct','color_temp_kelvin'].includes(k))
      || brightness_pct===undefined && color_temp_kelvin===undefined) throw new Error('HA_INVALID_LIGHT_CONFIG');
    if(brightness_pct!==undefined) {
      enrolled(this.entities,id,'set_brightness');
      if(!Number.isFinite(brightness_pct)||brightness_pct<=0||brightness_pct>100)throw new Error('HA_BRIGHTNESS_RANGE');
    }
    if(color_temp_kelvin!==undefined) {
      enrolled(this.entities,id,'set_color_temperature');
      if(!Number.isInteger(color_temp_kelvin))throw new Error('HA_KELVIN_RANGE');
    }
    if(!id.startsWith('light.'))throw new Error('HA_LIGHT_REQUIRED');
    const snapshot=structuredClone(parameters), previous=this.tails.get(id)??Promise.resolve();
    const work=previous.catch(()=>{}).then(async()=>{
      const state=await this.get(id,signal),a=state.attributes;
      if(brightness_pct!==undefined&&!(a.supported_color_modes??[]).some(mode=>mode!=='onoff'))throw new Error('HA_BRIGHTNESS_UNSUPPORTED');
      if(color_temp_kelvin!==undefined&&(!(a.supported_color_modes??[]).includes('color_temp')
        || !Number.isFinite(a.min_color_temp_kelvin)||!Number.isFinite(a.max_color_temp_kelvin)
        || color_temp_kelvin<a.min_color_temp_kelvin||color_temp_kelvin>a.max_color_temp_kelvin))throw new Error('HA_DEVICE_KELVIN_RANGE');
      if (this.client.configureLight) return this.client.configureLight(snapshot, state, signal);
      try {
        const response=await this.client.request('/api/services/nomi_automation/configure_light?return_response',snapshot,signal);
        const receipt=response.service_response;
        if(receipt?.entity_id!==id || !['confirmed','unconfirmed'].includes(receipt.status))throw new Error('HA_INVALID_LIGHT_RECEIPT');
        return {...receipt,requested:snapshot};
      } catch(error) {
        if(/^HA_HTTP_4\d\d$/.test(error.message))throw error;
        return {status:'uncertain',requested:snapshot,reason:'configuration_result_unknown_no_retry'};
      }
    });
    this.tails.set(id,work);
    work.finally(()=>{if(this.tails.get(id)===work)this.tails.delete(id);}).catch(()=>{});
    return work;
  }
  async logic(id, signal) {
    enrolled(this.entities, id, 'run');
    const [domain] = id.split('.');
    if (!['scene', 'script', 'automation'].includes(domain)) throw new Error('HA_LOGIC_DOMAIN_DENIED');
    const data = {entity_id: id};
    if (domain === 'automation') data.skip_condition = false;
    try {
      await this.client.request(`/api/services/${domain}/${domain === 'automation' ? 'trigger' : 'turn_on'}`, data, signal);
      return {status: 'accepted', entity_id: id};
    } catch (error) {
      if (/^HA_HTTP_4\d\d$/.test(error.message)) throw error;
      return {status: 'uncertain', entity_id: id};
    }
  }
}
