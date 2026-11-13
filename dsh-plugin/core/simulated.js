/** Explicit in-process HA double. Never constructs an HTTP or WebSocket client. */
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';

export class SimulatedHA extends EventEmitter {
  constructor(settings) {
    super(); this.simulated = true; this.ready = false; this.stopped = false; this.generation = 0;
    this.eventTypes = [...new Set(['state_changed', ...(settings.event_types ?? [])])];
    this.states = new Map(); this.calls = []; this.automations = new Map();
    this.health = {backend: 'simulated', ready: false, generation: 0, gaps: 0, last_event_at: null, last_error: null};
    for (const state of settings.simulated_states ?? []) {
      if (!settings.entities.some(entity => entity.entity_id === state.entity_id) || this.states.has(state.entity_id)
        || typeof state.state !== 'string' || !state.attributes || typeof state.attributes !== 'object'
        || Array.isArray(state.attributes)) throw new Error('HA_INVALID_SIMULATED_STATE');
      this.states.set(state.entity_id, structuredClone({...state, simulated: true}));
    }
    if (this.states.size !== settings.entities.length) throw new Error('HA_SIMULATED_STATES_REQUIRED');
  }
  start() {
    if (this.stopped || this.ready) return;
    this.ready = this.health.ready = true; this.health.generation = ++this.generation;
    this.emit('ready', {generation: this.generation});
  }
  async state(id, signal) {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error('HA_CANCELLED');
    const state = this.states.get(id);
    if (!state) throw new Error('HA_HTTP_404');
    return structuredClone(state);
  }
  setState(id, value, attributes = {}) {
    if (!this.ready || this.stopped) throw new Error('HA_CANCELLED');
    const before = this.states.get(id);
    if (!before || typeof value !== 'string') throw new Error('HA_INVALID_SIMULATED_STATE');
    const after = {...before, state: value, attributes: {...before.attributes, ...structuredClone(attributes)}};
    this.states.set(id, after);
    const event = {event_type: 'state_changed', time_fired: new Date().toISOString(),
      context: {id: randomUUID()}, data: {entity_id: id, old_state: structuredClone(before), new_state: structuredClone(after)}};
    this.health.last_event_at = event.time_fired;
    this.emit('event', event, this.generation);
    return structuredClone(event);
  }
  async request(route, data, signal) {
    signal?.throwIfAborted();
    if (!this.ready || this.stopped) throw new Error('HA_CANCELLED');
    if (route === '/api/states' && data === undefined) return [...this.states.values()].map(state => structuredClone(state));
    const read = /^\/api\/states\/([a-z0-9_]+\.[a-z0-9_]+)$/.exec(route);
    if (read && data === undefined) return this.state(read[1], signal);
    if(route==='/api/services/nomi_automation/configure_light?return_response') {
      const before=await this.state(data.entity_id,signal), attributes={};
      if(data.brightness_pct!==undefined)attributes.brightness=Math.round(data.brightness_pct*255/100);
      if(data.color_temp_kelvin!==undefined)attributes.color_temp_kelvin=data.color_temp_kelvin;
      this.calls.push({domain:'nomi_automation',action:'configure_light',data:structuredClone(data),simulated:true});
      this.setState(data.entity_id,before.state,attributes);
      return {service_response:{entity_id:data.entity_id,status:'confirmed',power_unchanged:true,
        before:{on:before.state==='on'},after:{on:before.state==='on',...attributes},simulated:true}};
    }
    const service = /^\/api\/services\/(light|switch|fan|climate|input_boolean|scene|script|automation)\/(turn_on|turn_off|trigger)$/.exec(route);
    if (!service || !data?.entity_id || !data.entity_id.startsWith(service[1] + '.') || !this.states.has(data.entity_id))
      throw new Error('HA_ROUTE_DENIED');
    const [, domain, action] = service;
    this.calls.push({domain, action, data: structuredClone(data), simulated: true});
    this.calls = this.calls.slice(-512);
    if (['scene', 'script', 'automation'].includes(domain)) return [];
    const attributes = {};
    if (data.brightness_pct !== undefined) attributes.brightness = Math.round(data.brightness_pct * 255 / 100);
    if (data.color_temp_kelvin !== undefined) attributes.color_temp_kelvin = data.color_temp_kelvin;
    this.setState(data.entity_id, action === 'turn_off' || data.brightness_pct === 0 ? 'off' : domain === 'climate' ? 'heat' : 'on', attributes);
    return [await this.state(data.entity_id, signal)];
  }
  async automationConfig(id, config, signal) {
    signal?.throwIfAborted();if(this.stopped)throw new Error('HA_CANCELLED');
    if (config !== undefined) { this.automations.set(id, structuredClone(config)); return {result:'ok'}; }
    if (!this.automations.has(id)) throw new Error('HA_HTTP_404');
    return structuredClone(this.automations.get(id));
  }
  async deleteAutomation(id, signal) { signal?.throwIfAborted(); this.automations.delete(id); return {result:'ok'}; }
  async close() { this.stopped = true; this.ready = this.health.ready = false; this.removeAllListeners(); }
}
