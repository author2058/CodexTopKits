import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowLayoutStore, WindowRestoreCancelled, windowRestoreCandidate, planWindowRestore, readWindowLayout, restoreWindowLayout, validateWindowPlacement, windowRoute, waitForWindowLayout } from '../src/window-layout.mjs';

const placement = (maximized = false) => ({ normal: { left: 2048, top: 106, right: 3128, bottom: 918 }, maximized, monitor: '\\\\.\\DISPLAY2', dpi: 96 });
const entry = (name, maximized = false) => ({ taskKey: `local:${name}`, title: name, placement: placement(maximized) });
const saved = () => ({ version: 1, browserIdentity: 'previous-browser', windows: [entry('one'), entry('two', true), entry('three')] });

test('restoration claims exact thread matches once and only reuses genuinely blank native windows', () => {
  const plan = planWindowRestore([entry('one'), entry('one'), entry('two')], [
    { targetId: 'other', taskKey: 'local:unrelated' }, { targetId: 'blank', taskKey: null }, { targetId: 'matching', taskKey: 'local:one' },
  ]);
  assert.deepEqual(plan.map(slot => [slot.targetId, !!slot.navigate]), [['matching', false], ['blank', true], [null, false]]);
});

test('restore opens missing chats sequentially, preserves maximized/normal bounds and restores saved tab order', async () => {
  const calls = [], live = [{ targetId: 'existing-three', taskKey: 'local:three' }, { targetId: 'blank', taskKey: null }];
  const result = await restoreWindowLayout(saved().windows, {
    list: async () => live,
    navigate: async (target, route) => calls.push(['navigate', target, route]),
    open: async route => { calls.push(['open', route]); return 'new-two'; },
    wait: async (target, key) => calls.push(['wait', target, key]),
    place: async (target, value) => { calls.push(['place', target, value]); return value; },
    order: async (target, index) => calls.push(['order', target, index]),
  });
  assert.deepEqual(result.map(x => x.targetId), ['blank', 'new-two', 'existing-three']);
  assert.deepEqual(calls.filter(c => c[0] === 'open'), [['open', '/local/two']]);
  assert.equal(calls.filter(c => c[0] === 'place')[1][2].maximized, true);
  assert.deepEqual(calls.filter(c => c[0] === 'order'), [['order', 'blank', 0], ['order', 'new-two', 1], ['order', 'existing-three', 2]]);
  assert.ok(calls.findIndex(c => c[0] === 'wait' && c[1] === 'blank') < calls.findIndex(c => c[0] === 'open'));
});

test('a same-browser controller restart does not restore or move any windows', async () => {
  const document = saved(), writes = [];
  const store = new WindowLayoutStore({ browserIdentity: document.browserIdentity, document, write: async (...args) => writes.push(args) });
  assert.equal(store.pending, false);
  assert.equal(await store.restore({ list: () => assert.fail('must not inspect/rearrange windows') }), null);
  assert.deepEqual(writes, []);
});

test('a new app session records its attempt before opening; capture cannot erase the prior snapshot mid-restore', async () => {
  const writes = [], document = saved();
  const store = new WindowLayoutStore({ browserIdentity: 'new-browser', document, write: async (_, data) => writes.push(data), now: () => 1793415600000 });
  let inspected = false;
  await store.restore({
    list: async () => { inspected = true; assert.equal(writes[0].restore.status, 'started'); assert.equal(await store.capture([entry('partial')]), false); return document.windows.map((e, i) => ({ taskKey: e.taskKey, targetId: `t${i}` })); },
    wait: async () => {}, place: async (_, value) => value, order: async () => {},
    open: () => assert.fail('all already open'), navigate: () => assert.fail('none blank'),
  });
  assert.equal(inspected, true); assert.equal(store.document.browserIdentity, 'new-browser');
  assert.equal(store.document.restore.status, 'completed');
  assert.equal(await store.restore({}), null);
});

test('capture is change-driven, serializes writes and never replaces the saved set with an empty shutdown', async () => {
  const writes = [], store = new WindowLayoutStore({ browserIdentity: 'live-browser', write: async (_, data) => writes.push(data) });
  assert.equal(await store.capture([entry('one')]), true);
  assert.equal(await store.capture([entry('one')]), false);
  assert.equal(await store.capture([]), false);
  assert.equal(writes.length, 1);
  assert.equal(await store.capture([entry('two')]), true);
  assert.equal(writes.at(-1).windows[0].taskKey, 'local:two');
});

test('native failures retain original identity and stop the restore without opening later windows', async () => {
  const error = new TypeError('native schema changed'), writes = [];
  const store = new WindowLayoutStore({ browserIdentity: 'new-browser', document: saved(), write: async (_, value) => writes.push(value) });
  let opened = 0;
  await assert.rejects(store.restore({ list: async () => [], open: async () => { opened++; throw error; } }), e => e === error);
  assert.equal(opened, 1); assert.equal(store.failed, true);
  assert.equal(writes.at(-1).restore.message, error.message);
  assert.deepEqual(writes.at(-1).windows, saved().windows);
  assert.equal(await store.capture([entry('partial')]), false);
});

test('an interrupted attempt is not silently replayed after a controller restart', () => {
  const document = saved(); document.restore = { browserIdentity: 'new-browser', status: 'started' };
  const store = new WindowLayoutStore({ browserIdentity: 'new-browser', document });
  assert.equal(store.pending, false); assert.equal(store.failed, false); assert.equal(store.resumedAttempt, true);
});

test('failed same-browser reload observes the current set and preserves the original snapshot', async () => {
  const document = saved(); document.restore = { browserIdentity: 'new-browser', status: 'failed', message: 'old timeout' };
  const store = new WindowLayoutStore({ browserIdentity: 'new-browser', document, write: async () => {} });
  assert.equal(await store.restore({ list: () => assert.fail('must not replay') }), null);
  assert.equal(await store.capture([entry('current-one'), entry('current-two')]), true);
  assert.deepEqual(store.document.restore.sourceWindows, document.windows);
  assert.equal(store.document.restore.status, 'observing');
  assert.equal(store.document.windows.length, 2);
});

test('later slots re-read live windows and adopt a manually opened loading chat instead of duplicating it', async () => {
  const live = [{ targetId: 'first', ready: true, taskKey: 'local:one' }], opened = [];
  const result = await restoreWindowLayout([entry('one'), entry('two')], {
    list: async () => live,
    wait: async target => { if (target === 'first') live.push({ targetId: 'manual-two', ready: false, pendingTaskKey: 'local:two' }); },
    open: async route => { opened.push(route); return 'duplicate'; }, navigate: () => assert.fail('not blank'),
    place: async (_, value) => value, order: async () => {},
  });
  assert.deepEqual(result.map(item => item.targetId), ['first', 'manual-two']);
  assert.deepEqual(opened, []);
});

test('an unknown loading startup window is awaited before deciding to open another', async () => {
  const window = { targetId: 'startup', ready: false, taskKey: null };
  await restoreWindowLayout([entry('one')], {
    list: async () => [window], ready: async target => { assert.equal(target, 'startup'); window.ready = true; },
    navigate: async (target, route) => { assert.equal(target, 'startup'); assert.equal(route, '/local/one'); },
    open: () => assert.fail('must reuse startup window'), wait: async () => {}, place: async (_, value) => value, order: async () => {},
  });
});

test('closing or navigating a restored window cancels remaining opens and allows capture', async () => {
  const abort = new AbortController(), error = new WindowRestoreCancelled('user closed window');
  const store = new WindowLayoutStore({ browserIdentity: 'new-browser', document: saved(), write: async () => {} });
  let opened = 0;
  await assert.rejects(store.restore({
    signal: abort.signal, list: async () => [], open: async () => { opened++; return 'first'; },
    wait: async () => abort.abort(error), place: () => assert.fail('must not place after cancel'),
  }), actual => actual === error);
  assert.equal(opened, 1); assert.equal(store.failed, false); assert.equal(store.document.restore.status, 'cancelled');
  assert.equal(await store.capture([entry('current')]), true);
  assert.deepEqual(store.document.restore.sourceWindows, saved().windows);
});

test('renderer readiness does not require a title, and stale initialRoute never overrides resolved identity', () => {
  const target = { id: 't', url: 'app://-/index.html?initialRoute=%2Flocal%2Fone' };
  assert.equal(windowRestoreCandidate(target, null).pendingTaskKey, 'local:one');
  assert.equal(windowRestoreCandidate(target, { isMain: true, taskKey: 'local:two', conversationResolved: true }).pendingTaskKey, null);
  const draft = windowRestoreCandidate({ id: 'draft', url: 'app://-/index.html' }, { isMain: true, taskKey: 'client-new-thread:abc' });
  assert.equal(draft.ready, true); assert.equal(draft.taskKey, null);
  assert.equal(planWindowRestore([entry('one')], [draft])[0].targetId, 'draft');
  const mounting = windowRestoreCandidate(target, { isMain: true, taskKey: 'client-new-thread:abc', conversationResolved: false });
  assert.equal(planWindowRestore([entry('one')], [mounting])[0].targetId, target.id);
  assert.equal(planWindowRestore([entry('one')], [mounting])[0].navigate, undefined);
  assert.equal(windowRestoreCandidate({ id: 'avatar', url: 'app://-/index.html?initialRoute=%2Favatar-overlay' }, { isMain: true }), null);
  assert.equal(windowRestoreCandidate({ id: 'voice', url: 'app://-/detached-window.html' }, { isMain: true }), null);
});

test('controller readiness wait aborts immediately and removes its event/timer waiter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiters = new Set();
  const abort = new AbortController(), reason = new WindowRestoreCancelled('closed');
  const pending = waitForWindowLayout(waiters, () => false, 'test', abort.signal);
  assert.equal(waiters.size, 1);
  abort.abort(reason);
  await assert.rejects(pending, actual => actual === reason);
  assert.equal(waiters.size, 0);
  t.mock.timers.tick(60000);
});

test('conversation route and placement validation reject malformed stored input rather than guessing', () => {
  assert.equal(windowRoute('local:abc-123'), '/local/abc-123');
  assert.equal(windowRoute('ssh-box:abc-123'), '/local/abc-123?hostId=ssh-box');
  for (const key of ['abc', 'local:../abc', 'local:abc?steal=1', null]) assert.throws(() => windowRoute(key), TypeError);
  assert.throws(() => validateWindowPlacement({ ...placement(), normal: { left: 5, right: 2, top: 0, bottom: 10 } }), TypeError);
  assert.throws(() => validateWindowPlacement({ ...placement(), maximized: 'false' }), TypeError);
});

test('UTF-8 persisted snapshot loads exactly; missing and malformed files have different outcomes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-window-layout-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const file = path.join(directory, 'layout.json');
  assert.equal(await readWindowLayout(file), null);
  const document = saved(); document.windows[0].title = '中文测试窗口🌿';
  const store = new WindowLayoutStore({ file, browserIdentity: document.browserIdentity });
  await store.capture(document.windows);
  const actual = await readWindowLayout(file);
  assert.equal(actual.windows[0].title, '中文测试窗口🌿');
  const bytes = await fs.readFile(file); assert.notEqual(bytes[0], 0xEF);
  await fs.writeFile(file, 'not json', 'utf8');
  await assert.rejects(readWindowLayout(file), SyntaxError);
});
