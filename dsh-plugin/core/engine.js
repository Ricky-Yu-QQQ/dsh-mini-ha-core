import {createHash, randomUUID} from 'node:crypto';
import {matches, predicate, validateRule} from './model.js';
import {fingerprint} from './fingerprint.js';

export const errorCode = error => /^HA_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'HA_EXECUTION_FAILED';
const eventSummary = event => ({event_type: event.event_type, time_fired: event.time_fired,
  entity_id: event.data?.entity_id, from: event.data?.old_state?.state, to: event.data?.new_state?.state,
  context_id: event.context?.id});
const eventKey = event => createHash('sha256').update(JSON.stringify(event)).digest('hex');

export class RuleEngine {
  constructor({store, client, controls, settings, agent}) {
    Object.assign(this, {store, client, controls, settings, agent});
    this.callbacks = new Map(); this.timers = new Map(); this.active = new Set();
    this.tail = Promise.resolve(); this.pending = 0; this.closed = false;
    this.health = {queued: 0, dropped: 0, last_error: null};
    this.generation = 0;
  }
  validate(rule) { return validateRule(rule, this.controls.entities, this.client.eventTypes); }
  list() { return this.store.rules(); }
  async put(input, expectedRevision, options = {}) {
    const rule = this.validate(input);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('HA_REVISION_REQUIRED');
    if (rule.enabled) { this.preflight(rule); await this.validateStateFields(rule, options.signal); }
    const saved = this.store.saveRule(rule, expectedRevision, options);
    if (saved.committed) this.cancelTimer(rule.id);
    return saved.rule;
  }
  saveDraft(input, expectedRevision, {signal, origin} = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('HA_REVISION_REQUIRED');
    if (input?.enabled !== false) throw new Error('HA_DRAFT_MUST_BE_DISABLED');
    const rule = this.validate(input);
    if (rule.actions.some(action => action.type !== 'control')) throw new Error('HA_DRAFT_ACTION_DENIED');
    const hash = fingerprint(rule);
    const id = fingerprint({base_revision: expectedRevision, hash});
    return this.store.saveDraft({id, rule, hash, base_revision: expectedRevision, origin, at: new Date().toISOString()}, signal);
  }
  async publishDraft(id, enabled, options = {}) {
    const draft = this.store.draft(id);
    if (!draft) throw new Error('HA_DRAFT_NOT_FOUND');
    if (typeof enabled !== 'boolean') throw new Error('HA_INVALID_RULE');
    if (draft.published_revision) {
      const version = this.store.version(draft.rule.id, draft.published_revision).rule;
      if (version.enabled !== enabled) throw new Error('HA_DRAFT_ALREADY_PUBLISHED');
      return version;
    }
    return this.put({...draft.rule, enabled}, draft.base_revision, {...options, change: 'publish', draftId: id});
  }
  async setEnabled(id, expectedRevision, enabled, options = {}) {
    const existing = this.store.rule(id);
    if (!existing) throw new Error('HA_RULE_NOT_FOUND');
    if (typeof enabled !== 'boolean') throw new Error('HA_INVALID_RULE');
    const {revision, updated_at, ...rule} = existing;
    return this.put({...rule, enabled}, expectedRevision, {...options, change: enabled ? 'enable' : 'disable'});
  }
  async rollback(id, expectedRevision, targetRevision, options = {}) {
    const previous = this.store.version(id, targetRevision)?.rule;
    if (!previous) throw new Error('HA_RULE_VERSION_NOT_FOUND');
    const {revision, updated_at, ...rule} = previous;
    return this.put({...rule, enabled: false}, expectedRevision, {...options, change: 'rollback', targetRevision});
  }
  async testDraft(id, event, states, {signal, origin} = {}) {
    const draft = this.store.draft(id);
    if (!draft) throw new Error('HA_DRAFT_NOT_FOUND');
    if (!event || typeof event !== 'object' || Array.isArray(event) || Buffer.byteLength(JSON.stringify(event)) > 8192
      || !Array.isArray(states) || states.length > 17) throw new Error('HA_INVALID_RULE_SAMPLE');
    const snapshot = new Map();
    const entities = new Set([draft.rule.trigger.entity_id, ...draft.rule.conditions.map(c => c.entity_id)]);
    for (const input of states) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('HA_INVALID_RULE_SAMPLE');
      const {entity_id, state, attributes = {}} = input;
      if (!entities.has(entity_id) || snapshot.has(entity_id) || typeof state !== 'string' || state.length > 128
        || !attributes || typeof attributes !== 'object' || Array.isArray(attributes)
        || Buffer.byteLength(JSON.stringify(attributes)) > 4096) throw new Error('HA_INVALID_RULE_SAMPLE');
      snapshot.set(entity_id, {entity_id, state, attributes});
    }
    const result = await this.evaluate({...draft.rule, enabled: true}, event, signal, async entity => {
      if (!snapshot.has(entity)) throw new Error('HA_RULE_SAMPLE_STATE_MISSING');
      return snapshot.get(entity);
    });
    this.store.recordDraftCheck(id, {event, states, ...result, origin, at: new Date().toISOString()}, signal);
    return {...result, ...(draft.rule.trigger.for_ms ? {requires_continuous_ms: draft.rule.trigger.for_ms} : {}), actions: result.matched ? draft.rule.actions : [], executes: false};
  }
  async validateStateFields(rule, signal) {
    if (rule.trigger.type === 'state') {
      const state = await this.controls.get(rule.trigger.entity_id, signal);
      if (rule.trigger.entity_id.startsWith('binary_sensor.') && !['off', 'on'].includes(rule.trigger.to))
        throw new Error('HA_TRIGGER_VALUE_MISMATCH');
      const numeric = state.state.trim() !== '' && Number.isFinite(Number(state.state));
      if (numeric && [rule.trigger.from, rule.trigger.to].filter(value => value !== undefined)
        .some(value => value.trim() === '' || !Number.isFinite(Number(value)))) throw new Error('HA_TRIGGER_VALUE_MISMATCH');
    }
    for (const condition of rule.conditions) {
      const state = await this.controls.get(condition.entity_id, signal);
      if (['unknown', 'unavailable'].includes(state.state)) continue;
      if (condition.attribute && !Object.hasOwn(state.attributes, condition.attribute)) throw new Error('HA_CONDITION_ATTRIBUTE_MISSING');
      if (condition.equals === undefined) {
        const value = condition.attribute ? state.attributes[condition.attribute] : state.state;
        if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(Number(value)))
          throw new Error('HA_CONDITION_NOT_NUMERIC');
      }
    }
  }
  async remove(id, expectedRevision, options) {
    const result = this.store.removeRule(id, expectedRevision, options);
    this.cancelTimer(id);
    return result;
  }
  registerCallback(name, callback) {
    if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(name) || typeof callback !== 'function') throw new Error('HA_INVALID_CALLBACK');
    if (this.callbacks.has(name)) throw new Error('HA_CALLBACK_EXISTS');
    this.callbacks.set(name, callback);
    return () => { if (this.callbacks.get(name) === callback) this.callbacks.delete(name); };
  }
  preflight(rule) {
    for (const action of rule.actions) {
      if (action.type === 'callback' && !this.callbacks.has(action.name)) throw new Error('HA_CALLBACK_NOT_BOUND');
      if (action.type === 'agent' && !this.agent) throw new Error('HA_AGENT_NOT_CONFIGURED');
    }
  }
  bindings() {
    return {callbacks: [...this.callbacks.keys()], agent: !!this.agent,
      unbound_rules: this.list().filter(rule => {
        try { this.preflight(rule); return false; } catch { return true; }
      }).map(rule => rule.id)};
  }
  cancelTimer(id) { clearTimeout(this.timers.get(id)?.timer); this.timers.delete(id); }
  async gap(details) {
    this.generation++;
    for (const id of this.timers.keys()) this.cancelTimer(id);
    for (const controller of this.active) controller.abort(new Error('HA_EVENT_GAP'));
    return this.store.recordGap({...details, recorded_at: new Date().toISOString()});
  }
  accept(event, generation) {
    if (this.closed || !this.client.ready || !event || !this.client.eventTypes.includes(event.event_type)) return;
    const timestamp = Date.parse(event.time_fired), age = Date.now() - timestamp;
    if (!Number.isFinite(timestamp) || age < -5000 || age > (this.settings.max_event_age_ms ?? 60000)
      || Buffer.byteLength(JSON.stringify(event)) > 65536) { this.health.dropped++; return; }
    if (event.event_type === 'state_changed' && !this.controls.entities.has(event.data?.entity_id)) return;
    this.generation = generation;
    const snapshot = structuredClone(event);
    const trigger = event.event_type === 'state_changed' ? 'state:' + event.data?.entity_id : 'event:' + event.event_type;
    for (const rule of this.store.rules(trigger)) {
      if (rule.trigger.type === 'state' && rule.trigger.entity_id === event.data?.entity_id
        && event.data?.new_state?.state !== rule.trigger.to) this.cancelTimer(rule.id);
      if (!matches(rule, snapshot)) continue;
      if (rule.trigger.for_ms) {
        const key = eventKey(snapshot);
        if (this.timers.get(rule.id)?.eventKey === key) continue;
        this.cancelTimer(rule.id);
        const timer = setTimeout(() => {
          this.timers.delete(rule.id); this.enqueue(rule, snapshot, generation);
        }, rule.trigger.for_ms);
        this.timers.set(rule.id, {timer, eventKey: key});
      } else this.enqueue(rule, snapshot, generation);
    }
  }
  enqueue(rule, event, generation) {
    if (this.closed) return;
    if (this.pending >= (this.settings.max_queue ?? 128)) {
      this.health.dropped++;
      try { this.store.recordGap({reason: 'queue_overflow', rule_id: rule.id, recorded_at: new Date().toISOString()}); }
      catch (error) { this.health.last_error = errorCode(error); }
      return;
    }
    this.health.queued = ++this.pending;
    const work = this.tail.then(() => this.run(rule, event, generation));
    this.tail = work.catch(error => { this.health.last_error = errorCode(error); }).finally(() => { this.health.queued = --this.pending; });
  }
  async evaluate(rule, event, signal, read = (id, signal) => this.controls.get(id, signal)) {
    const conditions = [];
    if (!matches(rule, event)) return {matched: false, reason: 'trigger_mismatch', conditions};
    if (rule.trigger.type === 'state') {
      const state = await read(rule.trigger.entity_id, signal);
      if (state.state !== rule.trigger.to) return {matched: false, reason: 'trigger_state_changed', conditions};
    }
    for (const condition of rule.conditions) {
      const state = await read(condition.entity_id, signal);
      const passed = predicate(condition, state);
      const value = condition.attribute ? state.attributes?.[condition.attribute] : state.state;
      conditions.push({entity_id: condition.entity_id, ...(condition.attribute ? {attribute: condition.attribute} : {}),
        ...(value === undefined ? {} : {value}), passed});
      if (!passed) return {matched: false, reason: 'condition_false', conditions};
    }
    return {matched: true, conditions};
  }
  async dryRun(id, event) {
    const rule = this.store.rule(id);
    if (!rule) throw new Error('HA_RULE_NOT_FOUND');
    return {...await this.evaluate({...rule, enabled: true}, event), actions: rule.actions, executes: false,
      note: 'Current conditions checked; cooldown, delivery and physical behavior are not validated.'};
  }
  async run(queuedRule, event, generation) {
    if (this.closed || !this.client.ready || generation !== this.generation) return;
    if (Date.now() - Date.parse(event.time_fired) - (queuedRule.trigger.for_ms ?? 0) > (this.settings.max_event_age_ms ?? 60000)) {
      this.health.dropped++; return;
    }
    const rule = this.store.rule(queuedRule.id);
    if (!rule?.enabled || rule.revision !== queuedRule.revision) return;
    const {revision, updated_at, ...spec} = rule; this.validate(spec); this.preflight(rule);
    const controller = new AbortController(); this.active.add(controller);
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(new Error('HA_RULE_DEADLINE')), this.settings.action_timeout_ms ?? 90000);
    try {
      const start = new Date().toISOString(), started = performance.now();
      const key = `${rule.id}/${rule.revision}/${eventKey(event)}`;
      if (this.store.seenRun(key)) return;
      let evaluation;
      try { evaluation = await this.evaluate(rule, event, signal); }
      catch (error) { evaluation = {matched: false, error: errorCode(error)}; }
      if (signal.aborted && !evaluation.error) evaluation = {...evaluation, error: errorCode(signal.reason)};
      const status = evaluation.error ? 'failed' : evaluation.matched ? 'running' : 'skipped';
      const claim = this.store.claimRun({id: randomUUID(), key, rule_id: rule.id, revision: rule.revision, status,
        started_at: start, generation, event: eventSummary(event), evaluation, evaluate_ms: performance.now() - started,
        request: {rule, event}, action_claim: null, results: [],
        ...(status !== 'running' ? {finished_at: new Date().toISOString(), error: evaluation.error} : {}),
      }, {cooldown: rule.cooldown_ms, now: Date.now(), signal});
      if (claim?.status !== 'running') return;
      const results = [];
      const current = () => {
        signal.throwIfAborted();
        if (this.store.rule(rule.id)?.revision !== rule.revision) throw new Error('HA_RULE_CHANGED');
      };
      try {
        for (const [index, action] of rule.actions.entries()) {
          current();
          // Commit the dispatch intent before handing the action to the transport.
          const actionStarted = performance.now();
          const started_at = new Date().toISOString();
          this.store.updateRun(claim.id, {action_claim: {index, started_at}});
          current();
          let result;
          const context = {run_id: claim.id, rule_id: rule.id, revision: rule.revision,
            event: structuredClone(event), signal};
          if (action.type === 'control') {
            const {type, ...operation} = action; result = await this.controls.control(operation, signal, current);
          } else if (action.type === 'ha_logic') result = await this.controls.logic(action.entity_id, signal);
          else if (action.type === 'agent') result = await this.agent(action.prompt, context);
          else {
            const callback = this.callbacks.get(action.name);
            if (!callback) throw new Error('HA_CALLBACK_NOT_BOUND');
            // Callbacks are trusted plugin code and must honor the supplied signal.
            await callback({...context, payload: structuredClone(action.payload ?? {})});
            result = {status: 'completed', callback: action.name};
          }
          results.push({type: action.type, result, started_at, elapsed_ms: performance.now() - actionStarted});
          this.store.updateRun(claim.id, {results, action_claim: null});
          if (!['confirmed', 'accepted', 'completed'].includes(result?.status)) throw new Error('HA_ACTION_UNCONFIRMED');
        }
        this.finish(claim.id, 'completed', results);
      } catch (error) { this.finish(claim.id, 'failed', results, errorCode(error)); }
    } finally { clearTimeout(timeout); this.active.delete(controller); }
  }
  finish(id, status, results, error) {
    return this.store.updateRun(id, {status, results, error, finished_at: new Date().toISOString()});
  }

  async close() {
    this.closed = true;
    for (const id of this.timers.keys()) this.cancelTimer(id);
    for (const controller of this.active) controller.abort(new Error('HA_CANCELLED'));
    await this.tail; this.callbacks.clear();
  }
}
