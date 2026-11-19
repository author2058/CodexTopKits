import test from 'node:test';
import assert from 'node:assert/strict';
import { readNativeNotification } from '../src/renderer.mjs';

test('native flat notifications and legacy nested notifications preserve their original payload without copying or replay', () => {
  const params = { threadId: 'thread', turn: { id: 'turn' } };
  const flat = { type: 'mcp-notification', hostId: 'local', method: 'turn/started', params };
  assert.equal(readNativeNotification(flat), flat);
  assert.equal(readNativeNotification({ type: 'mcp-notification', hostId: 'local', notification: flat }), flat);
  assert.equal(readNativeNotification(flat).params, params);
  assert.equal(readNativeNotification({ type: 'mcp-response' }), null);
  const serialized = (0,eval)('(' + readNativeNotification.toString() + ')');
  assert.equal(serialized(flat), flat);
});

test('malformed typed notifications fail visibly instead of masquerading as an idle conversation', () => {
  for (const data of [{}, { method: '', params: {} }, { method: 'turn/started' }, { method: 'turn/started', params: [] }]) {
    assert.throws(() => readNativeNotification({ ...data, type: 'mcp-notification' }), /notification shape changed/);
  }
});
