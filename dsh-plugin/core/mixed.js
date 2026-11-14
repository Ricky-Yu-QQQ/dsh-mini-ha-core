import {EventEmitter} from 'node:events';

export class MixedDevices extends EventEmitter {
  constructor(sources, entities) {
    super();
    this.sources = sources;
    this.entities = entities;
    this.eventTypes = [...new Set(Object.values(sources).flatMap(client => client.eventTypes))];
    this.health = {backend: 'mixed', generation: 0, gaps: 0, last_event_at: null};
    for (const [name, client] of Object.entries(sources)) {
      client.on('event', event => {
        if (!client.ready || event.event_type === 'state_changed'
          && this.entities.get(event.data?.entity_id)?.source !== name) return;
        this.health.last_event_at = new Date().toISOString();
        this.emit('event', {...event, adapter: name}, this.health.generation);
      });
      client.on('gap', details => {
        this.health.gaps++;
        this.health.generation++;
        this.emit('gap', {...details, adapter: name});
      });
    }
  }
  get ready() { return Object.values(this.sources).some(client => client.ready); }
  forEntity(id) {
    const client = this.sources[this.entities.get(id)?.source];
    if (!client) throw new Error('HA_ENTITY_NOT_ENROLLED');
    return client;
  }
  state(id, signal) { return this.forEntity(id).state(id, signal); }
  start() { for (const client of Object.values(this.sources)) client.start(); }
  async close() { await Promise.all(Object.values(this.sources).map(client => client.close())); }
}
