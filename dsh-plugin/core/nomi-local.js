import {EventEmitter} from 'node:events';

export class NomiLocal extends EventEmitter {
  constructor(config, entities) {
    super();
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/nomi\/home\/api$/.test(config?.endpoint ?? '')
      || Number(new URL(config.endpoint).port) > 65535)
      throw new Error('HA_INVALID_NOMI_ENDPOINT');
    const ids = new Set();
    for (const entry of entities.values()) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(entry.nomi_id ?? '') || ids.has(entry.nomi_id))
        throw new Error('HA_INVALID_NOMI_DEVICE');
      ids.add(entry.nomi_id);
    }
    this.endpoint = config.endpoint;
    this.entities = entities;
    this.eventTypes = [];
    this.stop = new AbortController();
    this.health = {backend: 'nomi_local', ready: false};
  }

  get ready() { return this.health.ready; }

  async send(request, signal) {
    const signals = [this.stop.signal, AbortSignal.timeout(7000)];
    if (signal) signals.push(signal);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any(signals),
        headers: {'content-type': 'application/json', 'x-nomi-local': '1'},
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error('HA_HTTP_' + response.status);
      const value = await response.json();
      this.health.ready = true;
      return value;
    } catch (error) {
      this.health.ready = false;
      throw error;
    }
  }

  start() {
    void this.send({method: 'home-sources'}).catch(() => {});
  }

  close() { this.stop.abort(); }

  stateFrom(id, value) {
    if (typeof value?.state?.power !== 'boolean') throw new Error('HA_NOMI_READ_FAILED');
    return {entity_id: id, state: value.state.power ? 'on' : 'off', attributes: {}};
  }

  async state(id, signal) {
    const entry = this.entities.get(id);
    if (!entry) throw new Error('HA_ENTITY_NOT_ENROLLED');
    return this.stateFrom(id, await this.send({method: 'read', id: entry.nomi_id}, signal));
  }

  async writeLight(operation, before, signal) {
    const {entity_id: id, action} = operation;
    if (!['turn_on', 'turn_off'].includes(action)) throw new Error('HA_ACTION_DENIED');
    const power = action === 'turn_on';
    const expected = power ? 'on' : 'off';
    if (before.state === expected) return {status: 'confirmed', unchanged: true, state: before};
    const result = await this.send({method: 'set', id: this.entities.get(id).nomi_id,
      property: 'power', value: power}, signal);
    if (result.status !== 'confirmed' || result.state?.power !== power)
      return {status: 'unconfirmed', reason: 'device_readback_unconfirmed'};
    return {status: 'confirmed', state: this.stateFrom(id, result)};
  }
}
