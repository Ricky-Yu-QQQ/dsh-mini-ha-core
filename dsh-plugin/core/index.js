import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HAClient} from './client.js';
import {SimulatedHA} from './simulated.js';
import {MiotLAN} from './miot-lan.js';
import {RuleStore} from './store.js';
import {Controls} from './controls.js';
import {validateOperation, validateSettings} from './model.js';
import {fingerprint} from './fingerprint.js';
import {RuleEngine, errorCode} from './engine.js';

const rejectedControls = new Set([
  'HA_ENTITY_UNAVAILABLE', 'HA_ENTITY_NOT_ENROLLED', 'HA_ENTITY_READ_ONLY', 'HA_LIGHT_REQUIRED',
  'HA_INVALID_LIGHT_CONFIG', 'HA_LOGIC_DOMAIN_DENIED', 'HA_DEVICE_KELVIN_RANGE', 'HA_KELVIN_RANGE',
  'HA_BRIGHTNESS_RANGE', 'HA_COLOR_TEMPERATURE_UNSUPPORTED', 'HA_BRIGHTNESS_UNSUPPORTED',
]);

export class HomeCore {
  constructor(settings, {agent} = {}) {
    const backend = settings.ha_backend ?? 'live';
    if (!['live', 'simulated', 'miot_lan'].includes(backend)) throw new Error('HA_INVALID_BACKEND');
    if (backend === 'live' && (!path.isAbsolute(settings.credentials_path ?? '') || !settings.credentials_path.split(path.sep).includes('.local')))
      throw new Error('HA_PRIVATE_CREDENTIAL_PATH_REQUIRED');
    for (const [key, low, high] of [['max_queue', 1, 1024], ['request_timeout_ms', 100, 60000],
      ['max_event_age_ms', 1000, 300000], ['action_timeout_ms', 1000, 300000]]) {
      if (settings[key] !== undefined && (!Number.isInteger(settings[key]) || settings[key] < low || settings[key] > high))
        throw new Error('HA_INVALID_LIMIT');
    }
    const entities = validateSettings(settings);
    this.settings = settings;
    this.lifetime = new AbortController();
    this.direct = new Set();
    this.store = new RuleStore(settings.state);
    this.client = backend === 'miot_lan' ? new MiotLAN(settings, entities)
      : backend === 'simulated' ? new SimulatedHA(settings) : new HAClient(settings);
    const publicEntities = backend === 'miot_lan'
      ? new Map([...entities].map(([id, {miot_did, miot_config_path, miot_power, ...entry}]) =>
        [id, miot_power ? {...entry, actions: entry.actions ?? ['turn_on', 'turn_off']} : entry]))
      : entities;
    this.controls = new Controls(this.client, publicEntities);
    this.engine = new RuleEngine({store: this.store, client: this.client, controls: this.controls, settings, agent});
    this.client.on('event', (event, generation) => {
      if (!settings.native_automations?.exclusive) this.engine.accept(event, generation);
    });
    this.client.on('gap', details => {
      this.engine.gap(details).catch(error => { this.engine.health.last_error = errorCode(error); });
    });
  }

  async start() {
    await this.store.open();
    try {
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
      result = await perform(requested, signal);
    } catch (error) {
      const reason = errorCode(error);
      const rejected = rejectedControls.has(reason) || /^HA_HTTP_4\d\d$/.test(reason);
      result = {status: rejected ? 'rejected' : 'uncertain', reason};
    }
    const receipt = {...intent, ...result, finished_at: new Date().toISOString(), elapsed_ms: performance.now() - started};
    this.store.writeControl(receipt);
    return receipt;
  }

  status() {
    return {connection: {...this.client.health}, engine: {...this.engine.health}, bindings: this.engine.bindings(),
      rules: this.engine.list().length, recent_runs: this.store.runs({includeSkipped: false}).reverse(),
      recent_gaps: this.store.gaps()};
  }

  close(drain) {
    return this.closing ??= (async () => {
      this.lifetime.abort(new Error('HA_CANCELLED'));
      const transport = this.client.close();
      try { await Promise.all([this.engine.close(), drain, Promise.allSettled(this.direct)]); } finally {
        try { await transport; } finally { await this.store.close(); }
      }
    })();
  }
}
