import path from 'node:path';
import fs from 'node:fs/promises';
import {constants, watchFile, unwatchFile} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {MixedDevices} from './mixed.js';
import {VendorDevices, vendorTypes} from './vendor.js';
import {randomUUID} from 'node:crypto';
import {HAClient} from './client.js';
import {SimulatedHA} from './simulated.js';
import {MiotLAN} from './miot-lan.js';
import {RuleStore} from './store.js';
import {Controls} from './controls.js';
import {POWER_ACTIONS, POWER_DOMAINS, VENDOR_ACTIONS, validateOperation, validateRule, validateSettings} from './model.js';
import {fingerprint} from './fingerprint.js';
import {RuleEngine, errorCode} from './engine.js';

const rejectedControls = new Set([
  'HA_ENTITY_UNAVAILABLE', 'HA_ENTITY_NOT_ENROLLED', 'HA_ENTITY_READ_ONLY', 'HA_LIGHT_REQUIRED',
  'HA_INVALID_LIGHT_CONFIG', 'HA_LOGIC_DOMAIN_DENIED', 'HA_DEVICE_KELVIN_RANGE', 'HA_KELVIN_RANGE',
  'HA_BRIGHTNESS_RANGE', 'HA_COLOR_TEMPERATURE_UNSUPPORTED', 'HA_BRIGHTNESS_UNSUPPORTED',
  'HA_INVALID_LOCATION', 'HA_LOCATION_NOT_FOUND', 'HA_LOCATION_AMBIGUOUS', 'HA_INVALID_DEVICE_TYPE',
  'HA_ACTION_DENIED', 'HA_CONTROL_DOMAIN_DENIED',
]);

export class HomeCore {
  constructor(settings, {agent} = {}) {
    const backend = settings.ha_backend ?? 'live';
    if (!['live', 'simulated', 'miot_lan', 'mixed'].includes(backend)) throw new Error('HA_INVALID_BACKEND');
    if (backend === 'live' && (!path.isAbsolute(settings.credentials_path ?? '') || !settings.credentials_path.split(path.sep).includes('.local')))
      throw new Error('HA_PRIVATE_CREDENTIAL_PATH_REQUIRED');
    for (const [key, low, high] of [['max_queue', 1, 1024], ['request_timeout_ms', 100, 60000],
      ['max_event_age_ms', 1000, 300000], ['action_timeout_ms', 1000, 300000]]) {
      if (settings[key] !== undefined && (!Number.isInteger(settings[key]) || settings[key] < low || settings[key] > high))
        throw new Error('HA_INVALID_LIMIT');
    }
    this.settings = settings;
    this.lifetime = new AbortController();
    this.direct = new Set();
    this.store = new RuleStore(settings.state);
    this.baseEntities = validateSettings(settings);
    this.catalogFile = settings.catalog_path;
    if (this.catalogFile !== undefined && (typeof this.catalogFile !== 'string' || !path.isAbsolute(this.catalogFile)
      || !path.normalize(this.catalogFile).split(path.sep).includes('.local') || backend === 'simulated'
      || settings.native_automations)) throw new Error('HA_INVALID_CATALOG_PATH');
    this.publicEntities = new Map();
    if (backend === 'mixed') {
      const config = settings.adapters;
      if (!config || typeof config !== 'object' || Array.isArray(config)
        || Object.keys(config).some(key => !['miot_lan', 'live', 'vendor'].includes(key))
        || settings.native_automations)
        throw new Error('HA_INVALID_ADAPTERS');
      const sources = {};
      if (config.miot_lan) sources.miot_lan = new MiotLAN({...settings, miot_lan: config.miot_lan, event_types: []}, this.miotEntities(this.baseEntities));
      if (config.live) {
        const live = {...settings, ...config.live};
        if (!path.isAbsolute(live.credentials_path ?? '') || !path.normalize(live.credentials_path).split(path.sep).includes('.local'))
          throw new Error('HA_PRIVATE_CREDENTIAL_PATH_REQUIRED');
        sources.live = new HAClient(live);
      }
      if (config.vendor) sources.vendor = new VendorDevices(config.vendor, this.publicEntities);
      if (!Object.keys(sources).length) throw new Error('HA_INVALID_ADAPTERS');
      this.client = new MixedDevices(sources, this.publicEntities);
    } else {
      this.client = backend === 'miot_lan' ? new MiotLAN(settings, this.baseEntities)
        : backend === 'simulated' ? new SimulatedHA(settings) : new HAClient(settings);
    }
    this.applyCatalog(this.baseEntities);
    const miot = this.client instanceof MiotLAN ? this.client : this.client.sources?.miot_lan;
    miot?.on('inventory', () => this.applyCatalog(this.catalogEntities));
    const publicEntities = this.publicEntities;
    this.controls = new Controls(this.client, publicEntities);
    this.engine = new RuleEngine({store: this.store, client: this.client, controls: this.controls, settings, agent});
    this.client.on('event', (event, generation) => {
      if (!settings.native_automations?.exclusive) this.engine.accept(event, generation);
    });
    this.client.on('gap', details => {
      this.engine.gap(details).catch(error => { this.engine.health.last_error = errorCode(error); });
    });
  }

  miotEntities(entities) {
    return new Map([...entities].filter(([, entry]) => entry.source === 'miot_lan'));
  }

  applyCatalog(entities) {
    if (this.client instanceof MixedDevices) {
      const vendors = new Set();
      for (const entry of entities.values()) {
        if (!Object.hasOwn(this.client.sources, entry.source)) throw new Error('HA_INVALID_ENTITY_SOURCE');
        if (entry.source !== 'vendor') continue;
        const type = vendorTypes[entry.vendor];
        if (!Object.hasOwn(vendorTypes, entry.vendor) || !entry.entity_id.startsWith(type + '.') || vendors.has(entry.vendor)
          || entry.control_allowed && !entry.actions?.length || entry.actions?.some(action => !VENDOR_ACTIONS[type].includes(action)))
          throw new Error('HA_INVALID_VENDOR_ENTITY');
        vendors.add(entry.vendor);
      }
    }
    const miot = this.client instanceof MiotLAN ? this.client : this.client.sources?.miot_lan;
    const backendEntities = this.client instanceof MixedDevices ? this.miotEntities(entities) : entities;
    const enrollment = miot?.prepareEnrollment(backendEntities);
    const inventory = new Map(miot?.discovery.devices.map(device => [device.did, device]));
    this.publicEntities.clear();
    for (const [id, entry] of entities) {
      const {entity_id, zones, aliases, actions, control_allowed, local_verified, source, miot_power, vendor} = entry;
      if (this.settings.ha_backend !== 'mixed' && this.settings.ha_backend !== 'miot_lan') {
        this.publicEntities.set(id, entry);
        continue;
      }
      const discovered = inventory.get(entry.miot_did);
      const name = entry.name ?? discovered?.name?.slice(0, 80);
      const area = entry.area ?? (discovered?.roomName?.slice(0, 80) || undefined);
      this.publicEntities.set(id, Object.fromEntries(Object.entries({
        entity_id, name, area, zones, aliases, control_allowed, local_verified, source, vendor,
        actions: actions ?? (miot_power ? ['turn_on', 'turn_off'] : undefined),
      }).filter(([, value]) => value !== undefined)));
    }
    if (enrollment) miot.updateEnrollment(enrollment);
    this.catalogEntities = entities;
  }

  async refreshCatalog() {
    const file = await fs.open(this.catalogFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let update;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 524288)
        throw new Error('HA_INVALID_CATALOG_FILE');
      update = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    if (!Array.isArray(update?.entities)) throw new Error('HA_ENTITIES_REQUIRED');
    const entries = validateSettings({...this.settings, entities: update.entities.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('HA_INVALID_ENROLLMENT');
      return {...this.baseEntities.get(entry.entity_id), ...entry};
    })});
    const next = new Map([...this.baseEntities, ...entries]);
    // Preserve all admitted targets and immutable bindings across a hot update.
    for (const [id, old] of this.catalogEntities) {
      const current = next.get(id);
      if (!current || ['source','miot_did','miot_power','miot_config_path','vendor'].some(key => !isDeepStrictEqual(old[key], current[key])))
        throw new Error('HA_CATALOG_BINDING_CHANGED');
    }
    const verified = new Map([...next].map(([id, entry]) => [id, {
      ...entry, actions: entry.actions ?? (entry.miot_power ? ['turn_on', 'turn_off'] : undefined),
    }]));
    for (const {revision, updated_at, ...rule} of this.engine.list())
      validateRule(rule, verified, this.client.eventTypes);
    this.lifetime.signal.throwIfAborted();
    this.applyCatalog(next);
    this.catalogError = null;
  }

  async start() {
    await this.store.open();
    try {
      if (this.catalogFile) {
        await this.refreshCatalog();
        this.catalogWatch = () => {
          this.catalogRefresh = (this.catalogRefresh ?? Promise.resolve()).then(() => this.refreshCatalog())
            .catch(error => { this.catalogError = errorCode(error); });
        };
        watchFile(this.catalogFile, {interval: 1000, persistent: false}, this.catalogWatch);
      }
      for (const {revision, updated_at, ...rule} of this.engine.list()) this.engine.validate(rule);
      this.store.recordGap({reason: 'service_start', recorded_at: new Date().toISOString()});
      this.client.start();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  control(operation, options) {
    validateOperation(operation, this.controls.entities);
    return this.recordControl('control', operation, (request, signal) => this.controls.control(request, signal), options);
  }

  controlLights(request, options) {
    return this.controlGroup(request, options, 'control_lights');
  }

  controlGroup(request, options, kind = 'control_group') {
    const {area, zone, action, device_type = kind === 'control_lights' ? 'light' : undefined} = request;
    const fields = kind === 'control_lights' ? ['area', 'zone', 'action'] : ['area', 'zone', 'action', 'device_type'];
    if (!POWER_ACTIONS.includes(action) || !POWER_DOMAINS.includes(device_type) ||
        Object.keys(request).some(key => !fields.includes(key))) throw new Error('HA_INVALID_GROUP_OPERATION');
    return this.recordControl(kind, request, async (_, signal, groupId) => {
      const targets = this.controls.selectGroup({area, zone, device_type});
      const intent = this.store.control(groupId);
      this.store.writeControl({...intent, targets: targets.map(row => row.entity_id)});
      const results = [];
      const control = async ({entity_id}) => {
        if (signal.aborted) return {entity_id, status: 'cancelled'};
        try {
          const receipt = await this.control({entity_id, action}, {
            signal, origin: {session_id: groupId, call_id: entity_id},
          });
          return {entity_id, operation_id: receipt.operation_id, status: receipt.status};
        } catch (error) {
          const code = errorCode(error);
          return {entity_id, status: rejectedControls.has(code) ? 'rejected' : 'uncertain', reason: code};
        }
      };
      for (let i = 0; i < targets.length; i += 4) {
        results.push(...await Promise.all(targets.slice(i, i + 4).map(control)));
      }
      return {status: results.every(row => row.status === 'confirmed') ? 'confirmed' : 'partial', results};
    }, options);
  }

  configure(operation, options) {
    return this.recordControl('configure_light', operation, (request, signal) => this.controls.configure(request, signal), options);
  }

  runLogic(entity_id, options) {
    return this.recordControl('run_logic', {entity_id}, (request, signal) => this.controls.logic(request.entity_id, signal), options);
  }

  recordControl(kind, operation, perform, {signal, origin} = {}) {
    const lifetime = this.lifetime.signal;
    const scoped = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
    const work = this.performControl(kind, operation, perform, scoped, origin);
    this.direct.add(work);
    return work.finally(() => this.direct.delete(work));
  }

  async performControl(kind, operation, perform, signal, origin) {
    const requested = structuredClone(operation);
    const stableOrigin = origin?.session_id && origin?.call_id;
    const operation_id = stableOrigin ? fingerprint({session_id: origin.session_id, call_id: origin.call_id}) : randomUUID();
    const hash = fingerprint({kind, requested});
    const intent = {operation_id, kind, status: 'dispatching', requested, origin, hash, started_at: new Date().toISOString()};
    const previous = this.store.claimControl(intent, signal);
    if (previous) {
      if (previous.hash !== hash) throw new Error('HA_CONTROL_REQUEST_CONFLICT');
      return previous;
    }
    const started = performance.now();
    let result;
    try {
      result = await perform(requested, signal, operation_id);
    } catch (error) {
      const reason = errorCode(error);
      const rejected = rejectedControls.has(reason) || /^HA_HTTP_4\d\d$/.test(reason);
      result = {status: rejected ? 'rejected' : 'uncertain', reason};
    }
    const receipt = {...this.store.control(operation_id), ...result, finished_at: new Date().toISOString(), elapsed_ms: performance.now() - started};
    this.store.writeControl(receipt);
    return receipt;
  }

  status() {
    return {connection: {...this.client.health, ready: this.client.ready},
      ...(this.client.sources ? {adapters: Object.fromEntries(Object.entries(this.client.sources).map(([name, client]) => [name,
        {...client.health, ready: client.ready}]))} : {}),
      ...(this.catalogFile ? {catalog_error: this.catalogError ?? null} : {}),
      engine: {...this.engine.health}, bindings: this.engine.bindings(),
      rules: this.engine.list().length, recent_runs: this.store.runs({includeSkipped: false}).reverse(),
      recent_gaps: this.store.gaps()};
  }

  discovered() {
    const miot = this.client instanceof MiotLAN ? this.client : this.client.sources?.miot_lan;
    if (!miot?.config.discover) return {enabled: false, devices: []};
    const {devices, updated_at, error} = miot.discovery;
    const bindings = new Map();
    for (const entry of this.catalogEntities.values()) {
      if (!entry.miot_did) continue;
      const entries = bindings.get(entry.miot_did) ?? [];
      entries.push(entry.entity_id);
      bindings.set(entry.miot_did, entries);
    }
    return {enabled: true, updated_at, error, devices: devices.map(row => ({...row,
      entity_ids: bindings.get(row.did) ?? [], status: bindings.has(row.did) ? 'enrolled' : 'pending_enrollment'}))};
  }

  close(drain) {
    return this.closing ??= (async () => {
      this.lifetime.abort(new Error('HA_CANCELLED'));
      if (this.catalogWatch) unwatchFile(this.catalogFile, this.catalogWatch);
      const transport = this.client.close();
      try { await Promise.all([this.engine.close(), drain, this.catalogRefresh, Promise.allSettled(this.direct)]); } finally {
        try { await transport; } finally { await this.store.close(); }
      }
    })();
  }
}
