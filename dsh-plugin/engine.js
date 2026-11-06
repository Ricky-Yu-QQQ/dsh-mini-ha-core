import {createHash, randomUUID} from 'node:crypto';
import {matches, predicate, validateRule} from './model.js';

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
  list() { return this.store.snapshot().rules; }
  async put(input, expectedRevision, {signal} = {}) {
    const rule = this.validate(input);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('HA_REVISION_REQUIRED');
    if (rule.enabled) { this.preflight(rule); await this.validateStateFields(rule, signal); }
    return this.store.transact(data => {
      const index = data.rules.findIndex(item => item.id === rule.id), existing = data.rules[index];
      if ((existing?.revision ?? 0) !== expectedRevision) throw new Error('HA_RULE_REVISION_CONFLICT');
      if (!existing && data.rules.length >= 256) throw new Error('HA_RULE_LIMIT');
      const next = {...rule, revision: expectedRevision + 1, updated_at: new Date().toISOString()};
      if (existing) data.rules[index] = next; else data.rules.push(next);
      return next;
    }).then(result => { this.cancelTimer(rule.id); return result; });
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
  async remove(id, expectedRevision) {
    const result = await this.store.transact(data => {
      const rule = data.rules.find(item => item.id === id);
      if (!rule || rule.revision !== expectedRevision) throw new Error('HA_RULE_REVISION_CONFLICT');
      data.rules = data.rules.filter(item => item.id !== id);
      delete data.cooldowns[id];
      return {id, deleted: true};
    });
    this.cancelTimer(id); return result;
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
  gap(details) {
    this.generation++;
    for (const id of this.timers.keys()) this.cancelTimer(id);
    for (const controller of this.active) controller.abort(new Error('HA_EVENT_GAP'));
    return this.store.transact(data => { data.gaps.push({...details, recorded_at: new Date().toISOString()}); });
  }
  accept(event, generation) {
    if (this.closed || !this.client.ready || !event || !this.client.eventTypes.includes(event.event_type)) return;
    const timestamp = Date.parse(event.time_fired), age = Date.now() - timestamp;
    if (!Number.isFinite(timestamp) || age < -5000 || age > (this.settings.max_event_age_ms ?? 60000)
      || Buffer.byteLength(JSON.stringify(event)) > 65536) { this.health.dropped++; return; }
    if (event.event_type === 'state_changed' && !this.controls.entities.has(event.data?.entity_id)) return;
    this.generation = generation;
    const snapshot = structuredClone(event);
    for (const rule of this.list()) {
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
      this.store.transact(data => data.gaps.push({reason: 'queue_overflow', rule_id: rule.id,
        recorded_at: new Date().toISOString()})).catch(error => { this.health.last_error = errorCode(error); });
      return;
    }
    this.health.queued = ++this.pending;
    const work = this.tail.then(() => this.run(rule, event, generation));
    this.tail = work.catch(error => { this.health.last_error = errorCode(error); }).finally(() => { this.health.queued = --this.pending; });
  }
  async evaluate(rule, event, signal) {
    if (!matches(rule, event)) return false;
    if (rule.trigger.type === 'state') {
      const state = await this.controls.get(rule.trigger.entity_id, signal);
      if (state.state !== rule.trigger.to) return false;
    }
    for (const condition of rule.conditions) {
      if (!predicate(condition, await this.controls.get(condition.entity_id, signal))) return false;
    }
    return true;
  }
  async dryRun(id, event) {
    const rule = this.list().find(item => item.id === id);
    if (!rule) throw new Error('HA_RULE_NOT_FOUND');
    const matched = await this.evaluate(rule, event);
    return {matched: !!matched, actions: structuredClone(rule.actions), executes: false,
      note: 'Current conditions checked; cooldown, delivery and physical behavior are not validated.'};
  }
  async run(queuedRule, event, generation) {
    if (this.closed || !this.client.ready || generation !== this.generation) return;
    if (Date.now() - Date.parse(event.time_fired) - (queuedRule.trigger.for_ms ?? 0) > (this.settings.max_event_age_ms ?? 60000)) {
      this.health.dropped++; return;
    }
    const rule = this.list().find(item => item.id === queuedRule.id && item.revision === queuedRule.revision && item.enabled);
    if (!rule) return;
    // Validation also covers rules loaded from disk after the enrollment changes.
    const {revision, updated_at, ...spec} = rule; this.validate(spec); this.preflight(rule);
    const controller = new AbortController(); this.active.add(controller);
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(new Error('HA_RULE_DEADLINE')), this.settings.action_timeout_ms ?? 90000);
    let claim;
    try {
      if (!(await this.evaluate(rule, event, signal))) return;
      signal.throwIfAborted();
      const key = `${rule.id}/${rule.revision}/${eventKey(event)}`;
      claim = await this.store.transact(data => {
        const current = data.rules.find(item => item.id === rule.id);
        if (current?.revision !== rule.revision || !current.enabled || signal.aborted) return;
        if (data.runs.some(run => run.key === key)
          || Date.now() - (data.cooldowns[rule.id] ?? 0) < rule.cooldown_ms) return;
        const run = {id: randomUUID(), key, rule_id: rule.id, revision: rule.revision, status: 'running',
          started_at: new Date().toISOString(), generation, event: eventSummary(event),
          request: structuredClone({rule, event}), action_claim: null, results: []};
        data.cooldowns[rule.id] = Date.now(); data.runs.push(run); return run;
      });
      if (!claim) return;
      const results = [];
      try {
        for (const [index, action] of rule.actions.entries()) {
          signal.throwIfAborted();
          // Disabling or changing a running rule stops its remaining actions.
          if (!this.list().some(item => item.id === rule.id && item.revision === rule.revision && item.enabled))
            throw new Error('HA_RULE_CHANGED');
          // A crash can leave this action's outcome unknown; claim it before dispatch.
          await this.store.transact(data => {
            data.runs.find(run => run.id === claim.id).action_claim = {index, started_at: new Date().toISOString()};
          });
          signal.throwIfAborted();
          if (!this.list().some(item => item.id === rule.id && item.revision === rule.revision && item.enabled))
            throw new Error('HA_RULE_CHANGED');
          let result;
          const context = {run_id: claim.id, rule_id: rule.id, revision: rule.revision,
            event: structuredClone(event), signal};
          if (action.type === 'control') {
            const {type, ...operation} = action; result = await this.controls.control(operation, signal);
          } else if (action.type === 'ha_logic') result = await this.controls.logic(action.entity_id, signal);
          else if (action.type === 'agent') result = await this.agent(action.prompt, context);
          else {
            const callback = this.callbacks.get(action.name);
            if (!callback) throw new Error('HA_CALLBACK_NOT_BOUND');
            // Callbacks are trusted plugin code and must honor the supplied signal.
            await callback({...context, payload: structuredClone(action.payload ?? {})});
            result = {status: 'completed', callback: action.name};
          }
          results.push({type: action.type, result});
          await this.store.transact(data => Object.assign(data.runs.find(run => run.id === claim.id), {
            results: structuredClone(results), action_claim: null,
          }));
          if (!['confirmed', 'accepted', 'completed'].includes(result?.status)) throw new Error('HA_ACTION_UNCONFIRMED');
        }
        await this.finish(claim.id, 'completed', results);
      } catch (error) { await this.finish(claim.id, 'failed', results, errorCode(error)); }
    } finally { clearTimeout(timeout); this.active.delete(controller); }
  }
  finish(id, status, results, error) {
    return this.store.transact(data => Object.assign(data.runs.find(run => run.id === id), {
      status, results: structuredClone(results), error, finished_at: new Date().toISOString(),
    }));
  }
  async close() {
    this.closed = true;
    for (const id of this.timers.keys()) this.cancelTimer(id);
    for (const controller of this.active) controller.abort(new Error('HA_CANCELLED'));
    await this.tail; this.callbacks.clear();
  }
}
