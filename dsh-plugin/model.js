/** Declarative JSON rules. Device/event content is data; no eval or arbitrary URLs. */
export const ID = /^[a-z_]+\.[a-z0-9_]+$/;
const NAME = /^[a-z][a-z0-9_.-]{0,79}$/;
export const ACTIONS = ['turn_on', 'turn_off', 'set_brightness', 'set_color_temperature'];
const scalar = value => value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('HA_INVALID_FIELDS');
};
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;

export function validateSettings(settings) {
  if (!Array.isArray(settings.entities)) throw new Error('HA_ENTITIES_REQUIRED');
  if (settings.agent && (typeof settings.agent.provider !== 'string' || !settings.agent.provider
    || typeof settings.agent.model !== 'string' || !settings.agent.model
    || (settings.agent.max_tool_calls !== undefined && (!Number.isInteger(settings.agent.max_tool_calls)
      || settings.agent.max_tool_calls < 1 || settings.agent.max_tool_calls > 32))
    || (settings.agent.max_tokens !== undefined && (!Number.isInteger(settings.agent.max_tokens)
      || settings.agent.max_tokens < 64 || settings.agent.max_tokens > 4096)))) throw new Error('HA_INVALID_AGENT_CONFIG');
  const entities = new Map();
  for (const entry of settings.entities) {
    if (!ID.test(entry.entity_id) || entry.local_verified !== true || entities.has(entry.entity_id))
      throw new Error('HA_INVALID_ENROLLMENT');
    if (entry.actions && (!Array.isArray(entry.actions) || entry.actions.some(action => ![...ACTIONS, 'run'].includes(action))))
      throw new Error('HA_INVALID_ALLOWED_ACTION');
    entities.set(entry.entity_id, structuredClone(entry));
  }
  if ((settings.event_types ?? []).some(type => !NAME.test(type) || type === 'state_changed'))
    throw new Error('HA_INVALID_EVENT_TYPE');
  return entities;
}

export function enrolled(entities, id, action) {
  const entity = entities.get(id);
  if (!entity) throw new Error('HA_ENTITY_NOT_ENROLLED');
  if (action && (entity.control_allowed !== true || (entity.actions && !entity.actions.includes(action))))
    throw new Error('HA_ENTITY_READ_ONLY');
  return entity;
}

export function validateOperation(operation, entities) {
  only(operation, ['entity_id', 'action', 'value']);
  enrolled(entities, operation.entity_id, operation.action);
  if (!ACTIONS.includes(operation.action)) throw new Error('HA_ACTION_DENIED');
  const domain = operation.entity_id.split('.')[0];
  if (!['light', 'switch', 'fan', 'climate', 'input_boolean'].includes(domain)) throw new Error('HA_CONTROL_DOMAIN_DENIED');
  if (operation.action.startsWith('set_')) {
    if (domain !== 'light' || !Number.isFinite(operation.value)) throw new Error('HA_INVALID_LIGHT_VALUE');
    if (operation.action === 'set_brightness' && (operation.value < 0 || operation.value > 100)) throw new Error('HA_BRIGHTNESS_RANGE');
    if (operation.action === 'set_color_temperature' && (!Number.isInteger(operation.value) || operation.value < 1000 || operation.value > 20000))
      throw new Error('HA_KELVIN_RANGE');
  } else if (operation.value !== undefined) throw new Error('HA_UNEXPECTED_VALUE');
  return operation;
}

export function validateRule(input, entities, eventTypes) {
  only(input, ['id', 'name', 'enabled', 'trigger', 'conditions', 'actions', 'cooldown_ms']);
  if (!NAME.test(input.id) || !text(input.name, 160) || typeof input.enabled !== 'boolean') throw new Error('HA_INVALID_RULE');
  const trigger = input.trigger;
  if (trigger?.type === 'state') {
    only(trigger, ['type', 'entity_id', 'from', 'to', 'for_ms']);
    enrolled(entities, trigger.entity_id);
    if (!text(trigger.to, 128) || ['unknown', 'unavailable'].includes(trigger.to)
      || (trigger.from !== undefined && !text(trigger.from, 128))) throw new Error('HA_INVALID_STATE_TRIGGER');
    if (trigger.for_ms !== undefined && (!Number.isInteger(trigger.for_ms) || trigger.for_ms < 0 || trigger.for_ms > 86400000))
      throw new Error('HA_INVALID_DURATION');
  } else if (trigger?.type === 'event') {
    only(trigger, ['type', 'event_type', 'data']);
    if (trigger.event_type === 'state_changed' || !eventTypes.includes(trigger.event_type)) throw new Error('HA_EVENT_NOT_ENROLLED');
    if (!object(trigger.data) || Object.keys(trigger.data).length > 16
      || Object.entries(trigger.data).some(([key, value]) => !NAME.test(key) || !scalar(value))) throw new Error('HA_INVALID_EVENT_FILTER');
  } else throw new Error('HA_INVALID_TRIGGER');
  const conditions = input.conditions ?? [];
  if (!Array.isArray(conditions) || conditions.length > 16) throw new Error('HA_INVALID_CONDITIONS');
  for (const condition of conditions) {
    only(condition, ['entity_id', 'attribute', 'equals', 'above', 'below']);
    enrolled(entities, condition.entity_id);
    if (condition.attribute !== undefined && !NAME.test(condition.attribute)) throw new Error('HA_INVALID_ATTRIBUTE');
    if (condition.equals !== undefined) {
      if (!scalar(condition.equals) || condition.above !== undefined || condition.below !== undefined) throw new Error('HA_INVALID_PREDICATE');
    } else if (![condition.above, condition.below].some(Number.isFinite)
      || (condition.above !== undefined && !Number.isFinite(condition.above))
      || (condition.below !== undefined && !Number.isFinite(condition.below))) throw new Error('HA_INVALID_PREDICATE');
  }
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 16) throw new Error('HA_INVALID_ACTIONS');
  for (const action of input.actions) {
    if (action.type === 'control') {
      only(action, ['type', 'entity_id', 'action', 'value']);
      const {type, ...operation} = action; validateOperation(operation, entities);
    } else if (action.type === 'ha_logic') {
      only(action, ['type', 'entity_id']); enrolled(entities, action.entity_id, 'run');
      if (!/^(script|scene|automation)\./.test(action.entity_id)) throw new Error('HA_LOGIC_DOMAIN_DENIED');
    } else if (action.type === 'callback') {
      only(action, ['type', 'name', 'payload']);
      if (!NAME.test(action.name) || (action.payload !== undefined && (!object(action.payload)
        || Buffer.byteLength(JSON.stringify(action.payload)) > 4096))) throw new Error('HA_INVALID_CALLBACK');
    } else if (action.type === 'agent') {
      only(action, ['type', 'prompt']);
      if (!text(action.prompt, 4000)) throw new Error('HA_INVALID_AGENT_PROMPT');
    } else throw new Error('HA_INVALID_ACTION_TYPE');
  }
  const cooldown = input.cooldown_ms ?? 1000;
  if (!Number.isInteger(cooldown) || cooldown < 1000 || cooldown > 86400000) throw new Error('HA_INVALID_COOLDOWN');
  return structuredClone({...input, conditions, cooldown_ms: cooldown});
}

export function matches(rule, event) {
  const trigger = rule.trigger, data = event.data;
  if (!rule.enabled || !object(data)) return false;
  if (trigger.type === 'event') return event.event_type === trigger.event_type
    && Object.entries(trigger.data).every(([key, value]) => data[key] === value);
  // A snapshot/reconnect, removed entity or attribute-only update is not an edge.
  return event.event_type === 'state_changed' && data.entity_id === trigger.entity_id
    && data.old_state && data.new_state && !['unknown', 'unavailable'].includes(data.old_state.state)
    && data.old_state.state !== data.new_state.state && data.new_state.state === trigger.to
    && (trigger.from === undefined || data.old_state.state === trigger.from);
}

export function predicate(condition, state) {
  if (!state || ['unknown', 'unavailable'].includes(state.state)) return false;
  const value = condition.attribute ? state.attributes?.[condition.attribute] : state.state;
  if (condition.equals !== undefined) return value === condition.equals;
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return false;
  const number = Number(value);
  return Number.isFinite(number) && (condition.above === undefined || number > condition.above)
    && (condition.below === undefined || number < condition.below);
}
