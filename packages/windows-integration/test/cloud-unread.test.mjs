import test from 'node:test';
import assert from 'node:assert/strict';
import { installCloudUnreadControl, loadNativeCloudUnread } from '../src/cloud-unread.mjs';

function fixture({ badge = 1, cloud = ['cloud-1'], local = ['local-1'] } = {}) {
  const snapshot = { durable: cloud, local }, listeners = new Set(), calls = [], changes = [];
  const readState = {
    read: () => snapshot, isReady: () => true,
    subscribe({ listener }) { listeners.add(listener); return () => listeners.delete(listener); },
    forHost(host) { return { isReady: () => true, set(id, value) {
      calls.push({ host, id, value }); snapshot[host] = snapshot[host].filter((v) => v !== id); listeners.forEach((fn) => fn());
    } }; },
  };
  let badgeListener;
  const badgeStore = { getSnapshot: () => badge, subscribe(fn) { badgeListener = fn; return () => { badgeListener = null; }; } };
  const control = installCloudUnreadControl(readState, badgeStore, (id) => readState.forHost('durable').set(id, false), (v) => changes.push(v));
  return { control, snapshot, calls, changes, listeners, setBadge(v) { badge = v; badgeListener?.(); } };
}

test('clearing eligibility follows both native subscriptions without polling', () => {
  const f = fixture({ badge: 0 });
  assert.equal(f.control.status().visible, false);
  f.setBadge(1);
  assert.equal(f.changes.at(-1).visible, true);
  f.control.cleanup(); assert.equal(f.listeners.size, 0);
});
test('clears cloud only, including entries absent from the sidebar', async () => {
  const f = fixture({ cloud: ['orphan-1', 'orphan-2'] });
  assert.deepEqual(await f.control.clear(), ['orphan-1', 'orphan-2']);
  assert.deepEqual(f.snapshot.local, ['local-1']);
  assert.deepEqual(f.snapshot.durable, []);
  assert.equal(f.changes.at(-1).visible, false);
  assert.deepEqual(f.calls.map((c) => c.host), ['durable', 'durable']);
});
test('local-only unread never enables clearing', async () => {
  const f = fixture({ cloud: [] });
  assert.equal(f.control.status().visible, false);
  assert.deepEqual(await f.control.clear(), []);
  assert.equal(f.calls.length, 0);
});
test('unexpected native errors propagate unchanged', async () => {
  const error = new TypeError('native setter regression');
  const f = fixture();
  const readState = { read: () => ({ durable: ['cloud-1'] }), isReady: () => true,
    subscribe: () => () => {}, forHost: () => ({ isReady: () => true, set() { throw error; } }) };
  const control = installCloudUnreadControl(readState, { getSnapshot: () => 1, subscribe: () => () => {} }, () => { throw error; }, () => {});
  await assert.rejects(control.clear(), (e) => e === error);
  f.control.cleanup(); control.cleanup();
});

test('cloud discovery reuses Core RPC and finds only the native read state and badge subscriber', async () => {
  const readState = { read() {}, isUnread() {}, subscribe() {}, forHost() {}, isReady() {} }, badgeStore = { getSnapshot() {}, subscribe() {} }, marked = [];
  function Badge() { return 'electron-set-badge-count'; }
  const document = { getElementById: () => ({ __reactContainer$test: { type: Badge, memoizedState: { memoizedState: [badgeStore] } } }) };
  const assets = { async find(name, predicate) { assert.equal(name, 'conversation read state'); assert.ok(predicate('isUnread forHost isReady')); return { load: () => ({ state: readState }) }; } };
  const host = await loadNativeCloudUnread(document, { assets, nativeHost: { forHost: host => ({ markConversationAsRead: id => marked.push({ host, id }) }) } });
  assert.equal(host.readState, readState); assert.equal(host.badgeStore, badgeStore);
  await host.markRead('cloud'); assert.deepEqual(marked, [{ host: 'durable', id: 'cloud' }]);
  const esm = await loadNativeCloudUnread(document, { assets: { find: async () => null }, nativeHost: { moduleUrl: 'app://-/assets/shared.js' },
    importModule: async url => { assert.equal(url, 'app://-/assets/shared.js'); return { state: readState }; } });
  assert.equal(esm.readState, readState); assert.equal(esm.badgeStore, badgeStore);
  const original = new TypeError('native import failed');
  await assert.rejects(loadNativeCloudUnread(document, { assets: { find: async () => { throw original; } } }), error => error === original);
  await assert.rejects(loadNativeCloudUnread(document, { assets: { find: async () => null } }), /read-state module changed/);
});
