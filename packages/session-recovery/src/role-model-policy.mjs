import { families, normalizeSelection } from './model-effort-calculator.mjs';

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;

export function defaultRolePolicy() {
  return { version: 1, roles: [
    { id: 'responder', name: 'Responder', family: 'sol' },
    { id: 'implementer', name: 'Implementer', family: 'terra' },
    { id: 'operator', name: 'Operator', family: 'luna' },
    { id: 'reviewer', name: 'General reviewer', family: 'sol' },
    { id: 'advanced-reviewer', name: 'Advanced reviewer', family: 'astra' },
    { id: 'researcher', name: 'Researcher', family: 'astra' },
  ], selection: normalizeSelection() };
}

export function validateRolePolicy(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.roles)) throw new TypeError('Invalid role policy.');
  const ids = new Set();
  for (const role of value.roles) {
    if (!role || !validId(role.id) || ids.has(role.id) || !families.includes(role.family) || !validId(role.name)) throw new TypeError('Invalid or duplicate role.');
    ids.add(role.id);
  }
  return { version: 1, roles: value.roles.map(role => ({ id: role.id, name: role.name, family: role.family })), selection: normalizeSelection(value.selection) };
}

export function roleThreadKey(hostId, threadId) {
  if (!validId(hostId) || !validId(threadId)) throw new TypeError('Invalid host or thread ID.');
  return JSON.stringify([hostId, threadId]);
}
