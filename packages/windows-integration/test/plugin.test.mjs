import test from 'node:test';
import assert from 'node:assert/strict';
import windowsPlugin from '../src/index.mjs';

function fixture() {
  const calls = [], health = [], logs = [], handlers = new Set(); let closed = false;
  const worker = { powerReady: false,
    async open() { calls.push('open'); }, async close() { calls.push('close'); },
    async subscribePower(listener) { this.listener = listener; this.powerReady = true; await listener({ ready: true, sequence: 0, type: null, observedAt: 1 }); },
    async powerStatus() { calls.push('power'); return { ready: true, sequence: 0, type: null, observedAt: 1 }; },
    async foreground() { return 111; }, async placement(handle) { return { handle, processId: 123, maximized: true }; },
    async find() { throw new Error('Thread-title guessing must not be used'); }, async findTarget(targetId, processId) { calls.push({ lookup: targetId, processId }); return [targetId === 'a' ? 111 : 222]; },
    async focus(handle, processId) { calls.push({ handle, processId }); return { focused: handle, maximized: true }; },
  };
  const client = { closed: false, handlers, targets: () => [{ type: 'page', targetId: 'a', url: 'app://-/index.html' }],
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'SystemInfo.getProcessInfo') return { processInfo: [{ type: 'browser', id: 123 }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-' + params.targetId };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'owned-script' };
      if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'document.hasFocus()' ? true : true } };
      return {};
    }, async close() { this.closed = true; closed = true; },
  };
  const context = { cdp: { acquire: async () => client, onReconnect: () => () => {} }, log: async value => logs.push(value), setHealth: value => health.push(value),
    onHostState(listener) { listener({ managerUrl: 'http://127.0.0.1:1234/', health: { plugins: [] } }); return () => calls.push('unsubscribe'); } };
  const emit = message => Promise.all([...handlers].map(handler => handler(message)));
  const report = value => emit({ method: 'Runtime.bindingCalled', sessionId: 'session-a', params: { name: '__CDTK_WINDOWS_BRIDGE__', payload: JSON.stringify(value) } });
  return { client, context, worker, calls, health, logs, emit, report, get closed() { return closed; } };
}

test('independent Windows plugin uses the Core lease, preserves native focus identity and closes only its resources', async () => {
  const f = fixture(); let sleeps = 0;
  const plugin = await windowsPlugin({}, { platform: 'win32', createWorker: () => f.worker, sleep: async () => { sleeps++; } }).start(f.context);
  try {
    await plugin.check();
    await f.report({ kind: 'state', applicable: true, taskKey: 'local:one', title: 'Example', color: '#445566', focused: true, status: 'idle', errors: [] });
    await f.report({ kind: 'activate', targetId: 'a' });
    assert.ok(f.calls.some(value => value.handle === 111 && value.processId === 123));
    assert.equal(f.logs.find(value => value.event === 'window-activated').maximized, true);
    const state = (await plugin.management.request({ method: 'GET', url: new URL('http://localhost/api/state') })).body;
    assert.equal(state.autoSleep.enabled, false); assert.equal(state.windows[0].title, 'Example'); assert.equal(state.errors.length, 0); assert.equal(sleeps, 0);
  } finally { await plugin.close(); }
  assert.ok(f.closed); assert.equal(f.calls.filter(value => value === 'close').length, 1); assert.ok(f.calls.includes('unsubscribe'));
});

test('moon state is shared, resume revokes it, and target removal removes its tab without index remapping', async () => {
  const f = fixture();
  const plugin = await windowsPlugin({}, { platform: 'win32', createWorker: () => f.worker, sleep: async () => { throw new Error('Must not sleep'); } }).start(f.context);
  const state = async () => (await plugin.management.request({ method: 'GET', url: new URL('http://localhost/api/state') })).body;
  try {
    await plugin.check(); await f.report({ kind: 'state', applicable: true, title: 'One', taskKey: 'local:one', color: '#445566', status: 'idle', focused: false, errors: [] });
    await f.report({ kind: 'sleep-toggle', enabled: true }); assert.equal((await state()).autoSleep.enabled, true);
    const activity = (method, turnId) => f.report({ kind: 'activity', hostId: 'local', method, params: { threadId: 'one', turn: { id: turnId } } });
    await activity('turn/started', 'new'); await activity('turn/completed', 'old');
    assert.equal((await state()).windows[0].status, 'active');
    await f.report({ kind: 'state', applicable: true, title: 'One', taskKey: 'local:one', color: '#445566', status: 'idle', focused: false, errors: [] });
    assert.equal((await state()).windows[0].status, 'active');
    await f.worker.listener({ ready: true, sequence: 1, type: 'resume', observedAt: 100 }); assert.equal((await state()).autoSleep.enabled, false);
    await f.emit({ method: 'Target.targetDestroyed', params: { targetId: 'a' } }); assert.deepEqual((await state()).windows, []);
  } finally { await plugin.close(); }
});

test('original worker failure appears in health without pretending the window integration connected', async () => {
  const f = fixture(), original = new SyntaxError('Exact native startup failure'); f.worker.open = async () => { throw original; };
  const plugin = await windowsPlugin({}, { platform: 'win32', createWorker: () => f.worker }).start(f.context);
  try {
    await assert.rejects(plugin.check(), error => error === original);
    assert.ok(f.health.some(value => !value.ok && value.message === original.message));
    assert.equal(f.logs.find(value => value.event === 'windows-failed').stack, original.stack);
  } finally { await plugin.close(); }
});

test('automatic recovery replaces a timed out worker and clears its error without reinstalling healthy windows', async () => {
  const f = fixture(), open = f.worker.open;
  f.context.cdp.acquire = async () => { f.client.closed = false; return f.client; };
  let failing = true;
  f.worker.open = async () => { if (failing) throw Object.assign(new Error('Native window worker timed out while handling ping.'), { code: 'NATIVE_WORKER_TIMEOUT' }); return open(); };
  const plugin = await windowsPlugin({}, { platform: 'win32', createWorker: () => f.worker }).start(f.context);
  try {
    await assert.rejects(plugin.recover(), error => error.code === 'NATIVE_WORKER_TIMEOUT');
    failing = false; f.client.closed = false; await plugin.recover();
    assert.equal(f.health.at(-1).ok, true);
    const scripts = f.calls.filter(value => value.method === 'Page.addScriptToEvaluateOnNewDocument').length;
    await plugin.recover();
    assert.equal(f.calls.filter(value => value.method === 'Page.addScriptToEvaluateOnNewDocument').length, scripts);
    assert.equal(f.health.at(-1).ok, true);
  } finally { await plugin.close(); }
});

test('successful foreground mapping clears its old error without clearing renderer errors', async () => {
  const f = fixture(), original = f.worker.placement; let fail = true;
  f.worker.placement = async handle => { if (fail) throw new TypeError('Original mapping failure'); return original(handle); };
  const plugin = await windowsPlugin({}, { platform: 'win32', createWorker: () => f.worker }).start(f.context);
  const state = async () => (await plugin.management.request({ method: 'GET', url: new URL('http://localhost/api/state') })).body;
  const report = () => f.report({ kind: 'state', applicable: true, title: 'Example', taskKey: 'local:one', focused: true, status: 'idle', errors: [{ source: 'native', message: 'Unrelated renderer error' }] });
  try {
    await plugin.check(); await report(); await new Promise(resolve => setImmediate(resolve));
    assert.ok((await state()).errors.some(error => error.id === 'mapping:a'));
    fail = false; await report(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual((await state()).errors.map(error => error.message), ['Unrelated renderer error']);
  } finally { await plugin.close(); }
});

test('a reported delivery timeout is not duplicated as a persistent CDP error', async () => {
  const f = fixture(), send = f.client.send;
  const timeout = Object.assign(new Error('CDP command timed out: Runtime.evaluate'), { code: 'CDP_COMMAND_TIMEOUT' });
  let failing = false;
  f.client.send = async function(method, params, sessionId) {
    if (failing && method === 'Runtime.evaluate' && params.expression.includes('.setState(')) throw timeout;
    return send.call(this, method, params, sessionId);
  };
  const plugin = await windowsPlugin({}, { platform: 'win32', createWorker: () => f.worker }).start(f.context);
  const state = async () => (await plugin.management.request({ method: 'GET', url: new URL('http://localhost/api/state') })).body;
  const report = title => f.report({ kind: 'state', applicable: true, title, taskKey: 'local:one', focused: false, status: 'idle', errors: [] });
  try {
    await plugin.check(); failing = true;
    await assert.rejects(report('First'), error => error === timeout);
    f.client.onError(timeout);
    assert.ok((await state()).errors.some(error => error.id === 'delivery:a'));
    assert.ok(!(await state()).errors.some(error => error.id === 'cdp'));
    failing = false; await report('Recovered');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await state()).errors.length, 0);
    const unrelated = new Error('Real CDP transport failure');
    f.client.onError(unrelated);
    assert.ok((await state()).errors.some(error => error.id === 'cdp' && error.message === unrelated.message));
  } finally { await plugin.close(); }
});

test('a repeated delivery timeout with the same message is also recognized as reported', async () => {
  const f = fixture(), send = f.client.send, failures = [];
  let failing = false;
  f.client.send = async function(method, params, sessionId) {
    if (failing && method === 'Runtime.evaluate' && params.expression.includes('.setState(')) {
      const error = Object.assign(new Error('CDP command timed out: Runtime.evaluate'), { code: 'CDP_COMMAND_TIMEOUT' });
      failures.push(error); throw error;
    }
    return send.call(this, method, params, sessionId);
  };
  const plugin = await windowsPlugin({}, { platform: 'win32', createWorker: () => f.worker }).start(f.context);
  const state = async () => (await plugin.management.request({ method: 'GET', url: new URL('http://localhost/api/state') })).body;
  const report = title => f.report({ kind: 'state', applicable: true, title, taskKey: 'local:one', focused: false, status: 'idle', errors: [] });
  try {
    await plugin.check(); failing = true;
    await assert.rejects(report('First'));
    await assert.rejects(report('Second'));
    f.client.onError(failures.at(-1));
    assert.ok(!(await state()).errors.some(error => error.id === 'cdp'));
    failing = false; await report('Recovered');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await state()).errors.length, 0);
  } finally { await plugin.close(); }
});

test('check replaces a failed worker even while its old CDP lease remains open', async () => {
  const f = fixture(), original = new Error('Native window worker timed out while handling ping.'); let opens = 0;
  f.worker.open = async () => { if (++opens === 1) throw original; };
  const plugin = await windowsPlugin({}, { platform: 'win32', createWorker: () => f.worker }).start(f.context);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.health.at(-1).message, original.message);
    await plugin.check();
    assert.equal(opens, 2); assert.equal(f.health.at(-1).ok, true);
    assert.ok(f.calls.some(value => value.method === 'Runtime.addBinding'));
  } finally { await plugin.close(); }
});

test('reconnect received during the old worker handshake waits for it and then opens the new lease', async () => {
  const f = fixture(), handshake = Promise.withResolvers(); let reconnect, opens = 0;
  f.context.cdp.onReconnect = listener => { reconnect = listener; return () => {}; };
  f.context.cdp.acquire = async () => { f.client.closed = false; return f.client; };
  f.worker.open = async () => { if (++opens === 1) await handshake.promise; };
  const plugin = await windowsPlugin({}, { platform: 'win32', createWorker: () => f.worker }).start(f.context);
  try {
    await new Promise(resolve => setImmediate(resolve));
    f.client.closed = true;
    const resumed = reconnect();
    handshake.reject(Object.assign(new Error('Original suspended worker timeout'), { code: 'NATIVE_WORKER_TIMEOUT' }));
    await resumed;
    assert.equal(opens, 2); assert.equal(f.health.at(-1).ok, true);
    assert.ok(f.logs.some(value => value.message === 'Original suspended worker timeout'));
  } finally { await plugin.close(); }
});

test('unfocused windows with duplicate titles resolve by native target ID, not title, index or CDP activation', async () => {
  const f = fixture(); const plugin = await windowsPlugin({}, { platform: 'win32', createWorker: () => f.worker }).start(f.context);
  try {
    await plugin.check();
    await f.report({ kind: 'state', applicable: true, title: 'Same title', taskKey: 'local:one', color: '#445566', status: 'idle', focused: false, errors: [] });
    await f.emit({ method: 'Target.targetCreated', params: { targetInfo: { type: 'page', targetId: 'b', url: 'app://-/index.html' } } });
    await f.emit({ method: 'Runtime.bindingCalled', sessionId: 'session-b', params: { name: '__CDTK_WINDOWS_BRIDGE__', payload: JSON.stringify({ kind: 'state', applicable: true, title: 'Same title', taskKey: 'local:one', color: '#445566', status: 'idle', focused: false, errors: [] }) } });
    await f.report({ kind: 'activate', targetId: 'b' });
    assert.ok(f.calls.some(value => value.lookup === 'b' && value.processId === 123));
    assert.ok(f.calls.some(value => value.handle === 222 && value.processId === 123));
    assert.equal(f.calls.filter(value => value.method === 'Target.activateTarget').length, 0);
  } finally { await plugin.close(); }
});

test('optional Awake synchronization starts at the first real window and terminal notifications close activity without sleeping', async () => {
  const f = fixture(), writes = [], originalSend = f.client.send;
  f.client.send = async function(method, params, sessionId) {
    if (method === 'Runtime.evaluate' && params.expression.includes('readSleepActivity')) { f.calls.push({ method, params, sessionId }); return { result: { value: { loadedThreadIds: ['one'], busyThreadIds: [] } } }; }
    return originalSend.call(this, method, params, sessionId);
  };
  const plugin = await windowsPlugin({ awakeScript: 'C:/Awake/Update.ps1' }, { platform: 'win32', createWorker: () => f.worker,
    writeAwakeBatch: async (pwsh, script, batch) => { assert.equal(script, 'C:/Awake/Update.ps1'); writes.push(batch); }, sleep: async () => { throw new Error('Must not sleep'); } }).start(f.context);
  try {
    await plugin.check(); assert.equal(writes.length, 0);
    await f.report({ kind: 'state', applicable: true, title: 'One', taskKey: 'local:one', color: '#445566', focused: false, status: 'idle', errors: [] });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(writes.length, 1);
    await f.report({ kind: 'activity', hostId: 'local', method: 'turn/completed', params: { threadId: 'one', turn: { id: 'done', status: 'interrupted' } } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(writes.at(-1).events[0].outcome, 'interrupted');
    assert.ok(f.calls.some(value => value.params?.expression?.includes('"codex_awake"')));
    await f.report({ kind: 'activity', hostId: 'durable', method: 'turn/completed', params: {} });
    assert.equal(writes.length, 2);
  } finally { await plugin.close(); }
});

test('Awake handoff leaves events and activity reads available without the legacy writer', async () => {
  const f = fixture(), writes = [], activity = [], originalSend = f.client.send;
  f.client.send = async function(method, params, sessionId) {
    if (method === 'Runtime.evaluate' && params.expression.includes('readSleepActivity')) return { result: { value: { loadedThreadIds: ['one'], busyThreadIds: [] } } };
    return originalSend.call(this, method, params, sessionId);
  };
  const plugin = await windowsPlugin({ awakeScript: 'C:/Awake/Update.ps1', externalKits: ['awake-bridge'] }, { platform: 'win32', createWorker: () => f.worker,
    writeAwakeBatch: async (...args) => writes.push(args), sleep: async () => { throw new Error('Must not sleep'); } }).start(f.context);
  try {
    await plugin.check(); await f.report({ kind: 'state', applicable: true, title: 'One', taskKey: 'local:one', color: '#445566', focused: false, status: 'idle', errors: [] });
    const unsubscribe = plugin.onFeatureActivity((method, params) => activity.push({ method, params }));
    await f.report({ kind: 'activity', hostId: 'local', method: 'turn/completed', params: { threadId: 'one', turn: { id: 'done', status: 'interrupted' } } });
    assert.equal(writes.length, 0); assert.equal(activity[0].params.turn.status, 'interrupted'); assert.equal(plugin.awakeSettings().handedOff, true);
    assert.deepEqual(await plugin.readAwakeActivity(), { loadedThreadIds: ['one'], busyThreadIds: [] }); unsubscribe();
  } finally { await plugin.close(); }
});

test('activity timing correlates the host and renderer without recording payloads or replacing CDP failures', async () => {
  const f = fixture(), originalSend = f.client.send;
  const failure = Object.assign(new Error('original CDP timeout'), { code: 'CDP_COMMAND_TIMEOUT' });
  let reject = false;
  f.client.send = async function(method, params, sessionId) {
    if (method !== 'Runtime.evaluate' || !params.expression.includes('.readSleepActivity(')) return originalSend.call(this, method, params, sessionId);
    const [, source, readId] = params.expression.match(/readSleepActivity\("([^"]+)","([^"]+)"\)/);
    await f.report({ kind: 'activity-read-timing', readId, source, method: 'thread/loaded/list', status: 'started', elapsedMs: 0, privateContent: 'do not log' });
    if (reject) throw failure;
    return { result: { value: { busyThreadIds: [] } } };
  };
  const plugin = await windowsPlugin({ externalKits: ['awake-bridge'] }, { platform: 'win32', createWorker: () => f.worker }).start(f.context);
  try {
    await plugin.check();
    await f.report({ kind: 'state', applicable: true, focused: false, title: 'Private title', errors: [] });
    assert.deepEqual(await plugin.readAwakeActivity(), { busyThreadIds: [] });
    const events = f.logs.filter(value => value.event === 'activity-read-timing');
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(value => [value.method, value.status]), [['Runtime.evaluate', 'started'], ['thread/loaded/list', 'started'], ['Runtime.evaluate', 'succeeded']]);
    assert.ok(events.every(value => value.readId === events[0].readId && value.targetId === 'a' && value.source === 'codex_awake'));
    assert.ok(!JSON.stringify(events).includes('Private title') && !JSON.stringify(events).includes('do not log'));
    reject = true;
    await assert.rejects(plugin.readAwakeActivity(), error => error === failure);
    assert.equal(f.logs.at(-1).status, 'failed');
    assert.notEqual(f.logs.at(-1).readId, events[0].readId);
  } finally { await plugin.close(); }
});
