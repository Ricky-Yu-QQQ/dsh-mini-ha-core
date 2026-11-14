import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {constants, watchFile, unwatchFile} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const vendorTypes = {haier: 'washer', dreame: 'vacuum'};
const commands = {start: 'start', pause: 'pause', return_to_base: 'dock', select_program: 'program'};
const privatePath = file => typeof file === 'string' && path.isAbsolute(file) && path.normalize(file).split(path.sep).includes('.local');

export class VendorDevices extends EventEmitter {
  constructor(config, entities) {
    super();
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(config.endpoint) ||
        Number(new URL(config.endpoint).port || 80) > 65535 || !privatePath(config.config_path))
      throw new Error('HA_INVALID_VENDOR_CONFIG');
    this.config = config;
    this.report = path.join(path.dirname(config.config_path), 'vendor-state.private.json');
    this.entities = entities;
    this.states = new Map();
    this.eventTypes = ['state_changed'];
    this.health = {backend: 'vendor', ready: false, generation: 0, gaps: 0, last_event_at: null};
    this.stop = new AbortController();
  }

  get ready() { return [...this.states.values()].some(row => Date.now() - row.at < 70000); }

  start() {
    this.watcher = () => {
      this.refreshing = (this.refreshing ?? Promise.resolve()).then(() => this.refresh()).catch(() => this.disconnected());
    };
    watchFile(this.report, {interval: 500, persistent: false}, this.watcher);
    this.expiry = setInterval(() => {
      for (const [id, row] of this.states) if (Date.now() - row.at > 70000) this.gap(id);
      this.health.ready = this.ready;
    }, 5000).unref();
    this.watcher();
  }

  async readPrivate(file, limit) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > limit)
        throw new Error('HA_INVALID_VENDOR_FILE');
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }

  normalize(entity_id, vendor, report) {
    if (report?.available !== true) return {entity_id, state: 'unavailable', attributes: {}};
    if (vendor === 'dreame') return {entity_id, state: report.mode || 'unknown', attributes: report};
    const phases = Object.fromEntries((Array.isArray(report.drums) ? report.drums : [])
      .filter(drum => [1, 2].includes(drum.id) && drum.available && typeof drum.phase === 'string')
      .map(drum => ['drum_' + drum.id + '_phase', drum.phase]));
    const current = new Set(Object.values(phases));
    const state = current.size > 1 ? 'mixed' : [...current][0] ?? 'unknown';
    return {entity_id, state, attributes: {...report, ...phases}};
  }

  disconnected() {
    if (this.stop.signal.aborted) return;
    for (const id of this.states.keys()) this.gap(id);
    this.health.ready = false;
  }

  gap(id) {
    this.states.delete(id);
    this.health.gaps++;
    this.emit('gap', {reason: 'vendor_report_gap', entity_id: id});
  }

  async refresh() {
    if (this.stop.signal.aborted) return;
    const raw = await this.readPrivate(this.report, 262144);
    if (this.stop.signal.aborted) return;
    const now = Date.now();
    const updated = new Set();
    for (const [id, entity] of this.entities) {
      if (entity.source !== 'vendor') continue;
      const row = raw[entity.vendor];
      const at = row?.at * 1000;
      if (!row || !Number.isFinite(at) || now - at > 70000 || at - now > 5000 || !row.state) {
        if (this.states.has(id)) this.gap(id);
        continue;
      }
      updated.add(id);
      const before = this.states.get(id);
      if (before && at < before.at) continue;
      const after = this.normalize(id, entity.vendor, row.state);
      const reset = before && (at - before.at > 70000 || before.pushed && !row.push);
      if (reset) this.gap(id);
      this.states.set(id, {at, pushed: row.push === true, value: after});
      if (!before || reset || !before.pushed && row.push
        || at <= before.at || isDeepStrictEqual(before.value, after)) continue;
      const time_fired = new Date(at).toISOString();
      this.health.last_event_at = time_fired;
      this.health.ready = true;
      this.emit('event', {event_type: 'state_changed', time_fired, context: {id: randomUUID()},
        data: {entity_id: id, old_state: before.value, new_state: after}}, this.health.generation);
    }
    if (updated.size && !this.health.ready) this.health.generation++;
    this.health.ready = updated.size > 0;
  }

  async request(route, signal, command) {
    const {token} = await this.readPrivate(this.config.config_path, 16384);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token))
      throw new Error('HA_INVALID_VENDOR_CONFIG');
    const timeout = AbortSignal.timeout(13000);
    const response = await fetch(this.config.endpoint + route, {
      redirect: 'error', signal: AbortSignal.any([this.stop.signal, timeout, ...(signal ? [signal] : [])]),
      headers: {Authorization: 'Bearer ' + token, ...(command ? {'Content-Type': 'application/json'} : {})},
      ...(command ? {method: 'POST', body: JSON.stringify(command)} : {}),
    });
    if (!response.ok) throw new Error('HA_HTTP_' + response.status);
    return response.json();
  }

  async state(id, signal) {
    const {vendor} = this.entities.get(id);
    const cached = this.states.get(id);
    if (cached?.pushed && Date.now() - cached.at < 60000) return cached.value;
    return this.normalize(id, vendor, await this.request('/api/vendor/' + vendor + '/state', signal));
  }

  async performOperation(operation, signal) {
    const {entity_id, action, value} = operation;
    const {vendor} = this.entities.get(entity_id);
    try {
      const row = await this.request('/api/vendor/' + vendor + '/command', signal, {name: commands[action], value: value ?? true});
      const status = row.status === 'confirmed' && row.state?.available === true ? 'confirmed'
        : row.status === 'appliance-accepted' ? 'unconfirmed' : row.status === 'appliance-blocked' ? 'rejected' : 'uncertain';
      return {status, requested: operation, ...(row.state ? {state: this.normalize(entity_id, vendor, row.state)} : {})};
    } catch {
      return {status: 'uncertain', requested: operation, reason: 'vendor_result_unknown_no_retry'};
    }
  }

  async close() {
    this.stop.abort();
    clearInterval(this.expiry);
    if (this.watcher) unwatchFile(this.report, this.watcher);
    await this.refreshing;
  }
}
