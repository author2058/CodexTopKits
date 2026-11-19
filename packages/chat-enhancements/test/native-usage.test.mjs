import test from 'node:test';
import assert from 'node:assert/strict';
import { isNativeRateLimitQuery, findNativeRateLimitQuery } from '../src/native-usage.mjs';

test('usage reads and subscriptions recognize legacy and account-scoped push keys, not image quota', () => {
  const legacy = { queryKey: ['rate-limit-status'], state: { dataUpdatedAt: 100 } };
  const push = { queryKey: ['rate-limit-status', 'user', 'account'], state: { dataUpdatedAt: 200 } };
  const image = { queryKey: ['rate-limit-status', 'image-generation', 'context', 250], state: { dataUpdatedAt: 300 } };
  assert.equal(isNativeRateLimitQuery(legacy), true);
  assert.equal(isNativeRateLimitQuery(push), true);
  assert.equal(isNativeRateLimitQuery(image), false);
  assert.equal(isNativeRateLimitQuery({ queryKey: ['thread-usage', 'user', 'thread'] }), false);
  const client = { getQueryCache: () => ({ findAll: options => {
    assert.deepEqual(options, { queryKey: ['rate-limit-status'] });
    return [legacy, push, image];
  } }) };
  assert.equal(findNativeRateLimitQuery(client), push);
  assert.equal(findNativeRateLimitQuery(null), null);
});

test('usage helpers serialize into the renderer without module dependencies', () => {
  const isQuery = Function('return (' + isNativeRateLimitQuery.toString() + ')')();
  const find = Function('isNativeRateLimitQuery', 'return (' + findNativeRateLimitQuery.toString() + ')')(isQuery);
  const query = { queryKey: ['rate-limit-status'], state: { dataUpdatedAt: 1 } };
  assert.equal(find({ getQueryCache: () => ({ findAll: () => [query] }) }), query);
});
