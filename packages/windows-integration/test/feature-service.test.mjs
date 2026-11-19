import test from 'node:test';
import assert from 'node:assert/strict';
import createWindowsFeatureService from '../src/feature-service.mjs';

async function fixture(enabled) {
  const calls = [], snapshots = [], reports = [], worker = {
    async open() { calls.push('open'); }, async close() { calls.push('close'); },
    async foreground() { return 111; }, async placement(handle) { return { handle, processId: 123 }; },
    async findTarget(id, pid) { calls.push({ find: id, pid }); return [id === 'one' ? 111 : 333]; },
    async focus(handle, pid) { calls.push({ handle, pid }); return { maximized: true }; },
    async subscribePower(listener) { this.power = listener; await listener({ ready: true, sequence: 1, type: 'resume', observedAt: Date.now() }); }, async powerStatus() {},
  };
  let instance, sleeps = 0;
  instance = await createWindowsFeatureService({ enabled }, {
    cdp: { send: async () => ({ processInfo: [{ type: 'browser', id: 123 }] }) }, evaluatePage: async () => false,
    notify: async () => { if (instance) snapshots.push(instance.snapshot()); }, log: async value => calls.push(value), reportError: (error, source) => reports.push({ error, source }),
  }, { worker, sleep: async () => { sleeps++; } });
  return { instance, worker, calls, snapshots, reports, get sleeps() { return sleeps; } };
}

test('window service maps target identity after closure and preserves running-over-unread precedence', async () => {
  const f = await fixture(['window-tabs']);
  try {
    for (const id of ['one', 'two', 'three']) await f.instance.receive(id, { kind: 'window-state', applicable: true, focused: false, taskKey: 'local:' + id, title: id, status: 'idle', color: '#112233' });
    await f.instance.removeTarget('two'); await f.instance.receive('one', { kind: 'activate', targetId: 'three' });
    assert.deepEqual(f.calls.find(value => value.find), { find: 'three', pid: 123 });
    assert.deepEqual(f.calls.find(value => value.handle), { handle: 333, pid: 123 });
    const activity = (method, turnId) => f.instance.receive('one', { kind: 'window-activity', hostId: 'local', method, params: { threadId: 'three', turnId } });
    await activity('turn/completed', 'old'); await activity('turn/started', 'new');
    let row = f.instance.snapshot().windows.find(value => value.targetId === 'three'); assert.equal(row.unread, true); assert.equal(row.status, 'active');
    await activity('turn/completed', 'old'); assert.equal(row.status, 'active'); await activity('turn/completed', 'new'); assert.equal(row.status, 'idle');
    await f.instance.receive('three', { kind: 'window-state', applicable: true, focused: true, taskKey: 'local:three', title: 'three', status: 'active', color: '#112233' });
    row = f.instance.snapshot().windows.find(value => value.targetId === 'three'); assert.equal(row.unread, false); assert.equal(row.status, 'idle');
    assert.equal(f.sleeps, 0);
  } finally { await f.instance.close(); }
});

test('scheduled sleep works without the window-tabs feature, and resume or disabling revokes the armed state', async () => {
  const f = await fixture(['auto-sleep']);
  try {
    await f.instance.receive('one', { kind: 'sleep-toggle', enabled: true }); assert.equal(f.instance.snapshot().autoSleep.enabled, true);
    await f.worker.power({ ready: true, sequence: 2, type: 'resume', observedAt: Date.now() }); assert.equal(f.instance.snapshot().autoSleep.enabled, false);
    await f.instance.receive('one', { kind: 'sleep-toggle', enabled: true }); await f.instance.configure([]);
    await f.worker.power({ ready: true, sequence: 3, type: 'resume', observedAt: Date.now() });
    assert.equal(f.instance.snapshot().autoSleep.enabled, false); assert.equal(f.sleeps, 0);
    await assert.rejects(f.instance.receive('one', { kind: 'activate', targetId: 'one' }), /disabled/);
  } finally { await f.instance.close(); }
});

test('legacy handoff shares its existing controller and routes only enabled feature actions', async () => {
  const actions = [], owner = { featureState: () => ({ windows: [{ targetId: 'one' }], autoSleep: { enabled: true } }),
    onFeatureState(listener) { listener(); return () => actions.push('unsubscribe'); }, async dispatchFeatureAction(value) { actions.push(value); } };
  const service = await createWindowsFeatureService({ enabled: ['window-tabs'], legacyPlugin: 'windows' }, { getPlugin: () => owner, notify: async () => {} });
  await service.configure(['window-tabs']); assert.deepEqual(actions[0], { kind: 'sleep-toggle', enabled: false });
  await service.receive('one', { kind: 'activate', targetId: 'one' }); assert.deepEqual(actions[1], { kind: 'activate', targetId: 'one' });
  await assert.rejects(service.receive('one', { kind: 'sleep-toggle', enabled: true }), /disabled/);
  assert.equal(service.snapshot().windows[0].targetId, 'one'); service.close(); assert.equal(actions.at(-1), 'unsubscribe');
});
