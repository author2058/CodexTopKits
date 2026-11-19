import test from 'node:test';
import assert from 'node:assert/strict';
import { AwakeBridge, awakeTurnEvent } from '../src/awake-bridge.mjs';

test('only terminal lifecycle results close activity, not intermediate capacity/retry errors', () => {
  assert.equal(awakeTurnEvent('error', { willRetry: true }), null);
  for (const status of ['completed', 'failed', 'interrupted']) {
    assert.equal(awakeTurnEvent('turn/completed', { threadId: 'side', turn: { id: 't', status } }).outcome, status);
  }
  assert.throws(() => awakeTurnEvent('turn/completed', { threadId: 'side', turnId: 't', turnStatus: 'inProgress' }), /unknown status/);
});

test('startup snapshot and native failure delivery work without rollout; payload excludes content', async () => {
  const batches = [];
  const bridge = new AwakeBridge({ now: () => 123, readActivity: async () => ({ loadedThreadIds: ['active', 'side'], busyThreadIds: ['active'] }), write: async batch => batches.push(batch), onHealth: async () => {} });
  await bridge.refresh();
  await bridge.observe('turn/completed', { threadId: 'side', turn: { id: 't', status: 'failed', items: ['private output'] } });
  assert.equal(batches[0].snapshot.startedAt, 123);
  assert.equal(batches[1].events[0].outcome, 'failed');
  assert.equal(JSON.stringify(batches).includes('private output'), false);
});

test('disconnect does not swallow terminal event; original failure reports and propagates', async () => {
  const failure = new Error('backend disconnected'); const batches = [], errors = [];
  const bridge = new AwakeBridge({ readActivity: async () => { throw failure; }, write: async batch => batches.push(batch), onHealth: async error => errors.push(error) });
  await assert.rejects(bridge.observe('turn/completed', { threadId: 's', turnId: 't', turnStatus: 'interrupted' }), e => e === failure);
  assert.equal(batches[0].snapshot, null);
  assert.equal(batches[0].events[0].turnId, 't');
  assert.equal(errors[0], failure);
  bridge.readActivity = async () => ({ loadedThreadIds: [], busyThreadIds: [] });
  await bridge.refresh(); assert.equal(bridge.error, null);
});

test('events arriving during a snapshot are drained after it, never discarded', async () => {
  let resolveRead; const batches = [];
  const bridge = new AwakeBridge({ readActivity: () => new Promise(resolve => { resolveRead = resolve; }), write: async batch => batches.push(batch), onHealth: async () => {} });
  const first = bridge.refresh();
  const next = bridge.observe('turn/started', { threadId: 's', turnId: 'new' });
  bridge.readActivity = async () => ({ loadedThreadIds: ['s'], busyThreadIds: ['s'] });
  resolveRead({ loadedThreadIds: [], busyThreadIds: [] });
  await Promise.all([first, next]);
  assert.equal(batches.length, 2);
  assert.equal(batches[1].events[0].turnId, 'new');
});

test('write failure stays visible rather than being treated as synchronized', async () => {
  const failure = new Error('state write failed'); const errors = [];
  const bridge = new AwakeBridge({ readActivity: async () => ({ loadedThreadIds: [], busyThreadIds: [] }), write: async () => { throw failure; }, onHealth: async error => errors.push(error) });
  await assert.rejects(bridge.refresh(), e => e === failure);
  assert.equal(errors[0], failure); assert.equal(bridge.error, failure);
});
