import test from 'node:test';
import assert from 'node:assert/strict';
import { findNativeConversationStore, findNativeUsageClient, nativeUsageSnapshot } from '../src/native-client.mjs';
import { findNativeRateLimitQuery } from '../src/native-usage.mjs';

test('conversation lookup reads the existing live local store without loading or mutating it', () => {
  const client = { hostId: 'local', getConversation() {}, getThreadExecutionState() {} };
  const root = { __reactContainer$test: { child: { memoizedProps: { client } } } };
  assert.equal(findNativeConversationStore(root), client);
  client.disposed = true;
  assert.equal(findNativeConversationStore(root), null);
});

test('conversation lookup selects the requested host instead of the first mounted local store', () => {
  const local = { hostId: 'local', getConversation() {}, getThreadExecutionState() {} };
  const remote = { hostId: 'remote-control:env_test', getConversation() {}, getThreadExecutionState() {} };
  const root = { __reactContainer$test: { memoizedProps: { local }, child: { memoizedProps: { remote } } } };
  assert.equal(findNativeConversationStore(root, 'remote-control:env_test'), remote);
  assert.equal(findNativeConversationStore(root, 'durable'), null);
});

test('usage lookup selects the native rate-limit cache and preserves its update time', () => {
  const query = { queryKey: ['rate-limit-status', 'account', 'plan'], state: { dataUpdatedAt: 1000, data: { rate_limit: {
    primary_window: { used_percent: 80, limit_window_seconds: 18000, reset_at: 2 },
    secondary_window: { used_percent: 27, limit_window_seconds: 604800, reset_at: 2000 },
  } } } };
  const client = { getQueryCache: () => ({ findAll: () => [query] }), getQueryData() {} };
  const document = { getElementById: () => ({ __reactContainer$test: { memoizedProps: { client } } }) };
  assert.equal(findNativeUsageClient(document, findNativeRateLimitQuery), client);
  assert.deepEqual(nativeUsageSnapshot(client, findNativeRateLimitQuery), { weekly: { remainingPercent: 73, resetAt: 2000000 }, updatedAt: 1000 });
  query.state.data = {};
  assert.equal(nativeUsageSnapshot(client, findNativeRateLimitQuery), null);
});

test('unexpected native cache failures are not replaced with unavailable quota', () => {
  const error = new TypeError('native usage cache changed');
  const client = { getQueryCache() { throw error; } };
  assert.throws(() => nativeUsageSnapshot(client, findNativeRateLimitQuery), value => value === error);
});
