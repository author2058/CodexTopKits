import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoSleepMonitor, readSleepActivity, nativePowerState } from '../src/auto-sleep.mjs';

function fixture() {
  let time = 0, busy = [], next = 0;
  let read = async () => ({ busyThreadIds: busy });
  const timers = new Map(), published = [], sleeps = [], errors = [], reads = [];
  const monitor = new AutoSleepMonitor({
    readActivity: () => { reads.push(time); return read(); },
    publish: async state => { published.push(structuredClone(state)); },
    sleep: async () => { sleeps.push({ time, enabled: monitor.enabled, lastPublished: published.at(-1).enabled }); },
    onError: async error => { errors.push(error); }, now: () => time,
    setTimer: (callback, delay) => { timers.set(++next, { callback, at: time + delay }); return next; },
    clearTimer: id => timers.delete(id),
  });
  return { monitor, timers, published, sleeps, errors, reads, setBusy: ids => { busy = ids; }, setRead: callback => { read = callback; },
    tick: async ms => { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); } await new Promise(setImmediate); } };
}

test('enable and stop events never read early; idle waits a full quiet minute before its only read', async () => {
  const f = fixture();
  assert.equal(f.monitor.enabled, false);
  await f.monitor.setEnabled(true);
  assert.deepEqual(f.reads, []);
  await f.tick(59999); assert.deepEqual(f.reads, []); assert.equal(f.sleeps.length, 0);
  await f.tick(1); assert.deepEqual(f.sleeps, [{ time: 60000, enabled: false, lastPublished: false }]);
  assert.deepEqual(f.reads, [60000]);
});

test('new turn cancels quiet time; duplicate active/stop events from other windows do not query or extend it', async () => {
  const f = fixture(); await f.monitor.setEnabled(true); await f.tick(30000);
  await f.monitor.observe('turn/started', { threadId: 'child', turnId: 't1' });
  await f.monitor.observe('thread/status/changed', { threadId: 'child', status: { type: 'active' } });
  assert.equal(f.timers.size, 0); await f.tick(60000); assert.deepEqual(f.reads, []);
  await f.monitor.observe('thread/status/changed', { threadId: 'child', status: { type: 'idle' } });
  const deadline = f.monitor.deadline; await f.tick(10000);
  await f.monitor.observe('turn/completed', { threadId: 'child', turnId: 't1' });
  await f.monitor.observe('thread/status/changed', { threadId: 'child', status: { type: 'idle' } });
  assert.equal(f.monitor.deadline, deadline); assert.deepEqual(f.reads, []);
  await f.tick(49999); assert.equal(f.sleeps.length, 0); assert.deepEqual(f.reads, []);
  await f.tick(1); assert.equal(f.sleeps.length, 1); assert.deepEqual(f.reads, [150000]);
});

test('stale cached active states cannot block the delayed authoritative idle check', async () => {
  const f = fixture();
  await f.monitor.observe('turn/started', { threadId: 'a', turnId: 'a1' });
  await f.monitor.observe('turn/started', { threadId: 'b', turnId: 'b1' });
  await f.monitor.setEnabled(true);
  await f.monitor.observe('turn/completed', { threadId: 'a', turnId: 'a1' });
  await f.tick(59999); assert.deepEqual(f.reads, []);
  // The native snapshot says b also ended, but its terminal event was missed.
  await f.tick(1); assert.deepEqual(f.reads, [60000]); assert.equal(f.sleeps.length, 1);
});

test('a later genuine terminal event restarts quiet time even when its start was not seen', async () => {
  const f = fixture(); await f.monitor.setEnabled(true); await f.tick(50000);
  await f.monitor.observe('turn/completed', { threadId: 'late-child', turnId: 'c1' });
  await f.tick(10000); assert.deepEqual(f.reads, []);
  await f.tick(50000); assert.deepEqual(f.reads, [110000]);
});

test('manual off cancels; the delayed backend check catches an unseen active conversation', async () => {
  const f = fixture(); await f.monitor.setEnabled(true); await f.monitor.setEnabled(false);
  await f.tick(60000); assert.equal(f.sleeps.length, 0); assert.deepEqual(f.reads, []);
  await f.monitor.setEnabled(true); f.setBusy(['background']); await f.tick(60000);
  assert.equal(f.sleeps.length, 0); assert.equal(f.monitor.deadline, null); assert.equal(f.monitor.enabled, true);
  f.setBusy([]); await f.monitor.observe('turn/completed', { threadId: 'background', turnId: 'unseen' });
  await f.tick(60000); assert.equal(f.sleeps.length, 1);
});

test('new start during final off publication prevents sleep and retains the monitoring intent', async () => {
  const f = fixture(); await f.monitor.setEnabled(true);
  f.monitor.publish = async state => { if (!state.enabled) await f.monitor.observe('turn/started', { threadId: 'new', turnId: 'new1' }); };
  await f.tick(60000);
  assert.equal(f.sleeps.length, 0); assert.equal(f.monitor.enabled, true); assert.deepEqual(f.monitor.busyThreadIds, ['new']);
});

test('an explicit off during final publication remains off and does not sleep', async () => {
  const f = fixture(); await f.monitor.setEnabled(true); let toggled = false;
  f.monitor.publish = async state => { if (!state.enabled && !toggled) { toggled = true; await f.monitor.setEnabled(false); } };
  await f.tick(60000); assert.equal(f.sleeps.length, 0); assert.equal(f.monitor.enabled, false);
});

test('loaded list includes paginated background children; active approval wait blocks sleep', async () => {
  const snapshot = await readSleepActivity(async (method, params) => {
    if (method === 'thread/loaded/list') return params.cursor ? { data: ['child'], nextCursor: null } : { data: ['parent'], nextCursor: 'next' };
    return { thread: { id: params.threadId, status: params.threadId === 'child' ? { type: 'active', activeFlags: ['waitingOnApproval'] } : { type: 'idle' } } };
  });
  assert.deepEqual(snapshot, { threadCount: 2, loadedThreadIds: ['parent', 'child'], busyThreadIds: ['child'] });
  await assert.rejects(readSleepActivity(async () => ({ data: null })), /invalid/);
});

test('Awake and auto-sleep use distinct native request sources without changing the queried data', async () => {
  for (const source of ['auto_sleep', 'codex_awake']) {
    const calls = [];
    const snapshot = await readSleepActivity(async (method, params, requestSource) => {
      calls.push(requestSource);
      return method === 'thread/loaded/list' ? { data: ['a'], nextCursor: null } : { thread: { id: params.threadId, status: { type: 'idle' } } };
    }, source);
    assert.deepEqual(calls, [source + '_loaded_threads', source + '_thread_status']);
    assert.deepEqual(snapshot.busyThreadIds, []);
  }
});

test('activity timing identifies an unfinished phase and preserves concurrent reads and original errors', async () => {
  const events = [], pending = new Map();
  const read = readSleepActivity(async (method, params) => {
    if (method === 'thread/loaded/list') return { data: ['private-one', 'private-two'] };
    return new Promise((resolve, reject) => pending.set(params.threadId, { resolve, reject }));
  }, 'codex_awake', value => events.push(value));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.size, 2);
  assert.deepEqual(events.map(({ method, status }) => [method, status]), [
    ['thread/loaded/list', 'started'], ['thread/loaded/list', 'succeeded'], ['thread/read', 'started'],
  ]);
  const error = Object.assign(new Error('original native failure'), { code: 'ORIGINAL' });
  pending.get('private-one').reject(error);
  await assert.rejects(read, failure => failure === error);
  assert.equal(events.at(-1).status, 'failed');
  pending.get('private-two').resolve({ thread: { id: 'private-two', status: { type: 'idle' } } });
  assert.ok(events.every(value => Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0));
  assert.ok(!JSON.stringify(events).includes('private-'));
  const listEvents = [];
  await assert.rejects(readSleepActivity(async () => { throw error; }, 'codex_awake', value => listEvents.push(value)), failure => failure === error);
  assert.deepEqual(listEvents.map(({ method, status }) => [method, status]), [['thread/loaded/list', 'started'], ['thread/loaded/list', 'failed']]);
});

for (const message of ['mcp-response timed out.', 'Renderer evaluation failed: Error: App server request expired while queued\n    at appServerRequest']) {
  test('observed transient read failure preserves intent, reports the original error and waits another full minute: ' + message.split('\n')[0], async () => {
    const f = fixture(); await f.monitor.setEnabled(true);
    const error = new Error(message); let failed = false;
    f.setRead(async () => { if (!failed) { failed = true; throw error; } return { busyThreadIds: [] }; });
    await f.tick(60000);
    assert.equal(f.sleeps.length, 0); assert.equal(f.monitor.enabled, true); assert.equal(f.monitor.deadline, 120000);
    assert.equal(f.errors[0], error); assert.equal(f.published.at(-1).error, error.message);
    await f.tick(59999); assert.deepEqual(f.reads, [60000]);
    await f.tick(1); assert.deepEqual(f.reads, [60000, 120000]); assert.equal(f.sleeps.length, 1); assert.equal(f.monitor.error, null);
  });
}

test('unexpected read errors remain fatal with their original diagnostics and no automatic retry', async () => {
  const f = fixture(); await f.monitor.setEnabled(true);
  const error = new Error('deadline backend failure');
  f.setRead(async () => { throw error; });
  await f.tick(60000);
  assert.equal(f.sleeps.length, 0);
  assert.equal(f.monitor.enabled, false);
  assert.equal(f.errors[0], error);
  assert.equal(f.published.at(-1).error, error.message);
  await f.tick(60000); assert.deepEqual(f.reads, [60000]);
});

test('schema failure is not retried or mistaken for idle', async () => {
  const f = fixture(); await f.monitor.setEnabled(true); f.setRead(async () => ({ busyThreadIds: null }));
  await f.tick(60000); assert.equal(f.sleeps.length, 0); assert.equal(f.monitor.enabled, false);
  assert.match(f.errors[0].message, /snapshot is invalid/); assert.equal(f.timers.size, 0);
});

test('a new start invalidates a pending older idle snapshot; duplicate checks share one in-flight read', async () => {
  const f = fixture(); let resolveOld;
  f.setRead(() => new Promise(resolve => { resolveOld = resolve; }));
  await f.monitor.setEnabled(true); await f.tick(60000);
  const duplicate = f.monitor.commit(); assert.deepEqual(f.reads, [60000]);
  await f.monitor.observe('turn/started', { threadId: 'new', turnId: 'new1' });
  resolveOld({ busyThreadIds: [] }); await duplicate;
  assert.equal(f.monitor.deadline, null);
  assert.deepEqual(f.monitor.busyThreadIds, ['new']); assert.equal(f.sleeps.length, 0);
  f.setRead(async () => ({ busyThreadIds: [] }));
  await f.monitor.observe('turn/completed', { threadId: 'new', turnId: 'new1' });
  await f.tick(59999); assert.deepEqual(f.reads, [60000]); await f.tick(1); assert.equal(f.sleeps.length, 1);
});

test('a late completion of an older turn cannot cancel a newer active turn', async () => {
  const f = fixture(); await f.monitor.setEnabled(true);
  await f.monitor.observe('turn/started', { threadId: 'a', turnId: 'a2' });
  await f.monitor.observe('turn/completed', { threadId: 'a', turnId: 'a1' });
  assert.deepEqual(f.monitor.busyThreadIds, ['a']); assert.equal(f.monitor.deadline, null);
  await f.tick(60000); assert.deepEqual(f.reads, []);
});

const power = (sequence, type = 'suspend') => ({ ready: true, sequence, type, observedAt: 1792090000000 + sequence });

test('external sleep cancels the authorization and timer; wake and late stop cannot rearm it', async () => {
  const f = fixture(); await f.monitor.setEnabled(true); await f.tick(30000);
  await f.monitor.powerChanged(power(1));
  assert.equal(f.monitor.enabled, false); assert.equal(f.monitor.deadline, null); assert.equal(f.timers.size, 0);
  await f.monitor.powerChanged(power(2, 'resume'));
  await f.monitor.observe('turn/completed', { threadId: 'late', turnId: 'old' });
  await f.tick(120000);
  assert.deepEqual(f.reads, []); assert.equal(f.sleeps.length, 0); assert.equal(f.published.at(-1).enabled, false);
  // Only a fresh, explicit user activation permits another sleep.
  await f.monitor.setEnabled(true); await f.tick(60000); assert.equal(f.sleeps.length, 1);
});

test('resume alone revokes the authorization even if suspend was not delivered', async () => {
  const f = fixture(); await f.monitor.setEnabled(true);
  await f.monitor.powerChanged(power(1, 'resume')); await f.tick(60000);
  assert.equal(f.monitor.enabled, false); assert.equal(f.monitor.deadline, null);
  assert.deepEqual(f.reads, []); assert.equal(f.sleeps.length, 0);
});

test('activation waiting for native power readiness cannot rearm after suspend or explicit off', async () => {
  for (const boundary of ['power', 'off']) {
    const f = fixture(); let resolvePower;
    f.monitor.checkPower = () => new Promise(resolve => { resolvePower = resolve; });
    const activation = f.monitor.setEnabled(true);
    if (boundary === 'power') await f.monitor.powerChanged(power(1));
    else await f.monitor.setEnabled(false);
    resolvePower(); await activation; await f.tick(60000);
    assert.equal(f.monitor.enabled, false); assert.equal(f.timers.size, 0); assert.equal(f.sleeps.length, 0);
  }
});

test('revocation is immediate even if the UI disconnects; delivery is marked as a power boundary', async () => {
  const f = fixture(); await f.monitor.setEnabled(true);
  const error = new Error('CDP closed during suspend');
  f.monitor.publish = async (snapshot, options) => {
    assert.equal(snapshot.enabled, false); assert.equal(options.powerBoundary, true); throw error;
  };
  await assert.rejects(f.monitor.powerChanged(power(1)), e => e === error);
  assert.equal(f.monitor.enabled, false); assert.equal(f.timers.size, 0); assert.equal(f.monitor.deadline, null);
  await f.tick(60000); assert.deepEqual(f.reads, []); assert.equal(f.sleeps.length, 0);
});

test('idle response and transient rejection from before a power boundary cannot sleep or retry afterward', async () => {
  for (const rejectRead of [false, true]) {
    const f = fixture(); let resolveRead, rejectPending;
    f.setRead(() => new Promise((resolve, reject) => { resolveRead = resolve; rejectPending = reject; }));
    await f.monitor.setEnabled(true); await f.tick(60000);
    const pending = f.monitor.commit();
    await f.monitor.powerChanged(power(1)); await f.monitor.powerChanged(power(2, 'resume'));
    const error = new Error('App server request expired while queued');
    if (rejectRead) rejectPending(error); else resolveRead({ busyThreadIds: [] });
    await pending; await f.tick(120000);
    assert.equal(f.monitor.enabled, false); assert.equal(f.monitor.deadline, null); assert.equal(f.timers.size, 0);
    assert.equal(f.sleeps.length, 0); assert.deepEqual(f.reads, [60000]);
    if (rejectRead) assert.equal(f.errors[0], error);
  }
});

test('power boundary during final off publication cannot restore the monitoring intent', async () => {
  const f = fixture(); await f.monitor.setEnabled(true); let emitted = false;
  f.monitor.publish = async state => {
    if (!state.enabled && !emitted) { emitted = true; await f.monitor.powerChanged(power(1)); }
  };
  await f.tick(60000); await f.tick(60000);
  assert.equal(f.monitor.enabled, false); assert.equal(f.timers.size, 0); assert.equal(f.sleeps.length, 0);
});

test('native power-state checks catch a queued boundary before the read or after off publication', async () => {
  for (const boundaryAt of [2, 3]) {
    const f = fixture(); let checks = 0;
    f.monitor.checkPower = async () => { if (++checks === boundaryAt) await f.monitor.powerChanged(power(1, 'resume')); };
    await f.monitor.setEnabled(true); await f.tick(60000);
    assert.equal(f.monitor.enabled, false); assert.equal(f.sleeps.length, 0);
    assert.deepEqual(f.reads, boundaryAt === 2 ? [] : [60000]);
  }
});

test('duplicate or older power records do not revoke a later explicit activation', async () => {
  const f = fixture(); await f.monitor.powerChanged(power(1)); await f.monitor.powerChanged(power(2, 'resume'));
  await f.monitor.setEnabled(true);
  assert.equal(await f.monitor.powerChanged(power(2, 'resume')), false);
  assert.equal(await f.monitor.powerChanged(power(1)), false);
  assert.equal(f.monitor.enabled, true); await f.tick(60000); assert.equal(f.sleeps.length, 1);
});

test('native power listener failure propagates unchanged and prevents a sleeping fallback', async () => {
  const f = fixture(); await f.monitor.setEnabled(true);
  const error = new TypeError('native power callback unavailable');
  f.monitor.checkPower = async () => { throw error; };
  await f.tick(60000);
  assert.equal(f.errors[0], error); assert.equal(f.monitor.enabled, false); assert.equal(f.sleeps.length, 0);
  await assert.rejects(f.monitor.setEnabled(true), e => e === error);
});

test('power protocol accepts initial subscription and rejects malformed or unrelated notifications', () => {
  assert.deepEqual(nativePowerState({ ready: true, sequence: 0, type: null, observedAt: 0 }), { ready: true, sequence: 0, type: null, observedAt: 0 });
  for (const value of [{ ready: false }, { ...power(1), type: 'window-blur' }, { ...power(1), sequence: -1 }, { ...power(1), observedAt: NaN }]) {
    assert.throws(() => nativePowerState(value), TypeError);
  }
});
