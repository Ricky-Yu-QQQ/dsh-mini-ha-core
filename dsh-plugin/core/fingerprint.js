import {createHash} from 'node:crypto';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

export const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
