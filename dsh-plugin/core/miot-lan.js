import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const privatePath = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value).split(path.sep).includes('.local');
const absolute = value => typeof value === 'string' && path.isAbsolute(value);
const fields = {1: 'power', 2: 'brightness', 3: 'kelvin'};
const propertyId = value => Number.isInteger(value) && value >= 1 && value <= 65535;
const did = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value);
const stateForPower = (entity_id, power) => ({entity_id, state: power ? 'on' : 'off', attributes: {}});
const validValue = (field, value) => field === 'power' ? typeof value === 'boolean'
  : Number.isInteger(value) && (field === 'brightness' ? value >= 0 && value <= 100 : value >= 1000 && value <= 20000);
const stateFor = (entity_id, light) => ({entity_id, state: light.power ? 'on' : 'off', attributes: {
  brightness: Math.round(light.brightness * 255 / 100), brightness_pct: light.brightness,
  color_temp_kelvin: light.kelvin, supported_color_modes: ['color_temp'],
  min_color_temp_kelvin: 2700, max_color_temp_kelvin: 6000,
}});

export class MiotLAN extends EventEmitter {
  constructor(settings, entities) {
    super();
    const config = settings.miot_lan ?? {};
    if (!absolute(config.control_binary) || !absolute(config.watch_binary)
      || !privatePath(config.gateway_path) || !privatePath(config.identity_path)
      || settings.native_automations || settings.event_types?.length)
      throw new Error('HA_INVALID_MIOT_LAN_CONFIG');
    this.config = config;
    this.discovery = {devices: [], updated_at: null, error: null};
    this.allowEmpty = settings.catalog_path !== undefined || settings.ha_backend === 'mixed';
    this.updateEnrollment(this.prepareEnrollment(entities));
    this.timeout = settings.request_timeout_ms ?? 15000;
    this.stop = new AbortController();
    this.eventTypes = ['state_changed'];
    this.health = {backend: 'miot_lan', ready: false, generation: 0, gaps: 0, last_event_at: null, last_error: null};
    this.ready = false;
    this.states = new Map();
  }

  prepareEnrollment(entities) {
    if ((!this.allowEmpty && entities.size < 1) || entities.size > 32) throw new Error('HA_INVALID_MIOT_LAN_CONFIG');
    const devices = new Set(), properties = new Map();
    for (const [id, entity] of entities) {
      const {miot_did, miot_config_path, miot_power: power} = entity;
      if (!did(miot_did) || !privatePath(miot_config_path)
        || (power === undefined ? !id.startsWith('light.') || entity.actions?.includes('run')
          : !/^(light|switch|fan|climate)\./.test(id) || !propertyId(power?.siid) || !propertyId(power?.piid)
            || entity.actions?.some(action => !['turn_on', 'turn_off'].includes(action))))
        throw new Error(power === undefined ? 'HA_INVALID_MIOT_LIGHT' : 'HA_INVALID_MIOT_POWER');
      devices.add(miot_did);
      const register = (siid, piid, field) => {
        const key = `${miot_did}/${siid}/${piid}`;
        if (properties.has(key)) throw new Error('HA_DUPLICATE_MIOT_PROPERTY');
        properties.set(key, {id, field});
      };
      if (power) register(power.siid, power.piid, 'power');
      else for (const [piid, field] of Object.entries(fields)) register(2, piid, field);
    }
    return {entities, devices, properties};
  }

  updateEnrollment(next) {
    const changed = this.properties?.size !== next.properties.size;
    Object.assign(this, next);
    if (changed && this.child) {
      this.reset('miot_catalog_updated');
      this.child.kill();
    }
  }

  async command(id, args, signal) {
    const entity = this.entities.get(id);
    if (!entity) throw new Error('HA_ENTITY_NOT_ENROLLED');
    signal = signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal;
    signal.throwIfAborted();
    const power = entity.miot_power;
    const target = power ? ['-expected-device', entity.miot_did, '-expected-power', `${power.siid}/${power.piid}`]
      : ['-expected-light', entity.miot_did];
    const base = ['-config', entity.miot_config_path, ...target, '-journal', '-'];
    const {error, stdout} = await new Promise(resolve => {
      execFile(this.config.control_binary, [...base, ...args], {signal, timeout: this.timeout, maxBuffer: 65536},
        (error, stdout) => resolve({error, stdout}));
    });
    let rows;
    try {
      rows = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (rows.some(row => typeof row?.phase !== 'string')) throw new Error('invalid control row');
    }
    catch { throw new Error('HA_MIOT_INVALID_RECEIPT'); }
    return {ok: !error, rows};
  }

  async state(id, signal) {
    const {ok, rows} = await this.command(id, ['-mode', 'read'], signal);
    signal?.throwIfAborted();
    const light = rows.find(row => row.phase === 'readback');
    const power = this.entities.get(id).miot_power;
    if (!ok || !light || !validValue('power', light.power)) throw new Error('HA_MIOT_READ_FAILED');
    if (power) {
      if (light.siid !== power.siid || light.piid !== power.piid) throw new Error('HA_MIOT_READ_FAILED');
      return stateForPower(id, light.power);
    }
    if (!validValue('brightness', light.brightness) || !validValue('kelvin', light.kelvin))
      throw new Error('HA_MIOT_READ_FAILED');
    return stateFor(id, light);
  }

  writeLight(operation, before, signal) {
    const {entity_id: id, action, value} = operation;
    const target = action === 'set_color_temperature' ? {kelvin: value}
      : action === 'set_brightness' && value > 0 ? {brightness: Math.max(1, Math.round(value))}
        : {power: action === 'turn_on'};
    return this.write(id, target, before, operation, signal);
  }

  configureLight(parameters, before, signal) {
    const target = {};
    if (parameters.brightness_pct !== undefined) target.brightness = Math.max(1, Math.round(parameters.brightness_pct));
    if (parameters.color_temp_kelvin !== undefined) target.kelvin = parameters.color_temp_kelvin;
    return this.write(parameters.entity_id, target, before, parameters, signal);
  }

  async write(id, target, before, requested, signal) {
    const snapshot = state => ({power: state.state === 'on', brightness: state.attributes.brightness_pct, kelvin: state.attributes.color_temp_kelvin});
    const current = snapshot(before), expected = {...target};
    if (!Object.hasOwn(expected, 'power')) expected.power = current.power;
    const matches = state => Object.entries(expected).every(([field, value]) => snapshot(state)[field] === value);
    const receipts = [];
    const result = (status, extra) => ({status, entity_id: id, requested, receipts, ...extra});
    if (matches(before)) return result('confirmed', {unchanged: true, state: before, power_unchanged: true});
    for (const [field, value] of Object.entries(target)) {
      if (current[field] === value) continue;
      signal?.throwIfAborted();
      const power = this.entities.get(id).miot_power;
      const siid = power?.siid ?? 2, piid = power?.piid ?? Number(Object.keys(fields).find(key => fields[key] === field));
      const matchesProperty = row => row.siid === siid && row.piid === piid;
      let command;
      try {
        command = await this.command(id, ['-mode', 'set', '-apply', '-property', field, '-value', JSON.stringify(value)], signal);
      } catch {
        return result('uncertain', {reason: 'device_result_unknown_no_retry'});
      }
      const ack = command.rows.find(row => row.phase === 'write-ack' && matchesProperty(row) && [0, 1].includes(row.code));
      const confirmed = !!ack && command.rows.some(row => row.phase === 'write-confirmed' && matchesProperty(row)
        && row.code === ack.code && row.value === value);
      if (ack) receipts.push({siid, piid, code: ack.code, value, readback_confirmed: confirmed});
      if (!command.ok || !confirmed)
        return result(ack ? 'unconfirmed' : 'uncertain', {reason: 'device_result_unknown_no_retry'});
    }
    let state;
    try { state = await this.state(id, signal); }
    catch { return result('unconfirmed', {reason: 'readback_failed'}); }
    return result(matches(state) ? 'confirmed' : 'unconfirmed', {state, power_unchanged: state.state === before.state});
  }

  start() {
    if (!this.loop && !this.stop.signal.aborted) this.loop = this.supervise();
  }

  reset(reason) {
    const wasReady = this.ready;
    this.ready = this.health.ready = false;
    this.baseline?.abort();
    this.baseline = null;
    this.states.clear();
    if (reason && wasReady) {
      this.health.gaps++;
      this.emit('gap', {reason, generation: this.health.generation});
    }
  }

  async seed(child) {
    this.reset('miot_subscription_replaced');
    const baseline = this.baseline = new AbortController();
    try {
      for (const id of this.entities.keys()) {
        let seeded = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const version = this.states.get(id);
          const state = await this.state(id, baseline.signal);
          if (baseline.signal.aborted) return;
          if (this.states.get(id) === version) {
            this.states.set(id, state);
            seeded = true;
            break;
          }
        }
        if (!seeded) throw new Error('HA_MIOT_BASELINE_UNSTABLE');
      }
      this.health.generation++;
      this.ready = this.health.ready = true;
      this.health.last_error = null;
      this.emit('ready', {generation: this.health.generation});
    } catch {
      if (!baseline.signal.aborted) {
        this.health.last_error = 'HA_MIOT_BASELINE_FAILED';
        child.kill();
      }
    }
  }

  message(message, child) {
    if (message.source === 'local-mips' && message.phase === 'inventory' && Array.isArray(message.devices)
      && message.devices.length <= 1024 && message.devices.every(row => did(row.did)
        && ['name', 'model', 'urn', 'roomId', 'roomName'].every(key => typeof row[key] === 'string') && typeof row.online === 'boolean')) {
      this.discovery = {devices: message.devices, updated_at: new Date().toISOString(), error: null};
      this.emit('inventory');
      return;
    }
    if (message.source === 'local-mips' && message.phase === 'inventory-error') {
      this.discovery.error = 'HA_MIOT_INVENTORY_UNAVAILABLE';
      return;
    }
    if (message.phase === 'subscribed' && message.source === 'local-mips') {
      void this.seed(child);
      return;
    }
    if (message.phase === 'gap' && message.reason === 'certificate_renewed') {
      this.reset('miot_certificate_renewed');
      return;
    }
    if (!this.baseline || message.phase !== 'device-property' || message.source !== 'local-mips') return;
    const property = this.properties.get(`${message.did}/${message.siid}/${message.piid}`);
    if (!property) return;
    const {id, field} = property;
    const age = Date.now() - Date.parse(message.at);
    if (!id || !field || !validValue(field, message.value) || !Number.isFinite(age) || age < -5000 || age > 60000) return;
    const before = this.states.get(id);
    if (!before?.attributes) {
      this.states.set(id, {});
      return;
    }
    const light = {power: before.state === 'on', brightness: before.attributes.brightness_pct,
      kelvin: before.attributes.color_temp_kelvin};
    if (light[field] === message.value) return;
    light[field] = message.value;
    const after = this.entities.get(id).miot_power ? stateForPower(id, light.power) : stateFor(id, light);
    this.states.set(id, after);
    if (!this.ready) return;
    this.health.last_event_at = message.at;
    this.emit('event', {event_type: 'state_changed', time_fired: message.at, source: message.source, context: {id: randomUUID()},
      data: {entity_id: id, old_state: before, new_state: after}}, this.health.generation);
  }

  async supervise() {
    const {watch_binary, gateway_path, identity_path} = this.config;
    let backoff = 250;
    while (!this.stop.signal.aborted) {
      if (!this.devices.size && !this.config.discover) {
        await delay(250, undefined, {signal: this.stop.signal}).catch(() => {});
        continue;
      }
      const generation = this.health.generation;
      const args = ['-gateway', gateway_path, '-identity', identity_path, '-device', [...this.devices].join(','),
        '-kind', 'property', '-duration', '0'];
      if (this.config.discover) args.push('-inventory');
      const child = this.child = spawn(watch_binary, args, {stdio: ['ignore', 'pipe', 'ignore']});
      child.on('error', () => { this.health.last_error = 'HA_MIOT_WATCH_START_FAILED'; });
      const maxLine = this.config.discover ? 2 * 1024 * 1024 : 65536;
      let pending = '', failed = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (failed || this.stop.signal.aborted) return;
        try {
          const lines = (pending + chunk).split('\n');
          pending = lines.pop();
          if (pending.length > maxLine) throw new Error('watch line exceeds limit');
          for (const line of lines) {
            if (line.length > maxLine) throw new Error('watch line exceeds limit');
            this.message(JSON.parse(line), child);
          }
        } catch {
          failed = true;
          this.health.last_error = 'HA_MIOT_WATCH_PROTOCOL';
          this.reset('miot_watch_protocol');
          child.kill();
        }
      });
      await new Promise(resolve => child.once('close', resolve));
      this.child = null;
      if (this.config.discover) this.discovery.error = 'HA_MIOT_WATCH_DISCONNECTED';
      this.reset(this.stop.signal.aborted ? null : 'miot_watch_disconnected');
      if (this.stop.signal.aborted) break;
      this.health.last_error ??= 'HA_MIOT_WATCH_DISCONNECTED';
      if (this.health.generation !== generation) backoff = 250;
      await delay(backoff, undefined, {signal: this.stop.signal}).catch(() => {});
      backoff = Math.min(backoff * 2, 30000);
    }
  }

  async close() {
    this.stop.abort(new Error('HA_CANCELLED'));
    this.reset();
    const child = this.child;
    child?.kill();
    const timeout = child && setTimeout(() => child.kill('SIGKILL'), 7000);
    try { await this.loop; } finally { clearTimeout(timeout); }
    this.removeAllListeners();
  }
}
