import test from 'node:test';
import assert from 'node:assert/strict';
import chatPlugin from '../src/index.mjs';
import { chatPayload } from '../src/payload.mjs';

test('retired reasoning expansion is absent while live output and scroll repair remain', () => {
  const source = chatPayload({ epoch: 'fixture' });
  assert.doesNotMatch(source, /installReasoningSummaries|publicReasoningSummaries|codex-reasoning-summaries/);
  assert.match(source, /installLiveOutput/);
  assert.match(source, /installScrollHandoffRepair/);
});

async function fixture(t, acquire, services = {}) {
  const health = [], logs = [], subscribers = new Set();
  const context = { cdp: { acquire, onReconnect: () => () => {} }, log: async value => logs.push(value), setHealth: value => health.push(value),
    onHostState(listener) { subscribers.add(listener); listener({ managerUrl: null, health: { plugins: [] } }); return () => subscribers.delete(listener); } };
  const plugin = await chatPlugin({}, { hardResetFetch: async () => Response.json({ data: { scheduled_reset: null } }), ...services }).start(context);
  t.after(() => plugin.close());
  const request = (pathname, method = 'GET') => plugin.management.request({ method, url: new URL(pathname, 'http://127.0.0.1') });
  return { plugin, request, health, logs, subscribers };
}

test('Chat is ready before the app starts, and close cancels only its own connection wait', async t => {
  let aborted = false;
  const { plugin, request, health, subscribers } = await fixture(t, ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }));
  assert.match((await request('/')).body, /Codex Chat Enhancements/);
  assert.deepEqual(plugin.management.title, { en: 'Chat Enhancements', 'zh-Hans': '聊天增强' });
  assert.equal(health.at(-1).ok, true);
  await plugin.close(); assert.equal(aborted, true); assert.equal(subscribers.size, 0);
});

test('window reports retain exact issue counts, share native usage, and clean only owned targets', async t => {
  const calls = [];
  const client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'main', type: 'page', url: 'app://codex/' }],
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.attachToTarget') return { sessionId: 'main-session' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'owned-script' };
      if (method === 'Runtime.evaluate') return { result: { value: {} } };
      return {};
    }, async close() { this.closed = true; } };
  const { plugin, request, health } = await fixture(t, async () => client);
  await new Promise(resolve => setImmediate(resolve));
  const send = async value => { for (const handler of client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'main-session', params: { name: '__CDTK_CHAT_BRIDGE__', payload: JSON.stringify(value) } }); };
  const updates = [], unsubscribe = (await request('/api/events')).subscribe(value => updates.push(value));
  await send({ kind: 'state', applicable: true, threadId: 'one', capabilities: {}, errors: [{ source: 'timer', message: 'Timing changed' }, { source: 'history', message: 'History changed' }] });
  assert.equal(health.at(-1).issueCount, 2);
  const snapshot = { weekly: { remainingPercent: 60, resetAt: 1900000000000 }, updatedAt: 1899000000000 };
  await send({ kind: 'usage', snapshot });
  assert.deepEqual((await request('/api/state')).body.usage, snapshot);
  assert.ok(calls.some(call => call.params?.expression?.includes('setUsage(')));
  const count = updates.length; await send({ kind: 'usage', snapshot }); assert.equal(updates.length, count);
  for (const handler of client.handlers) await handler({ method: 'Target.targetDestroyed', params: { targetId: 'main' } });
  assert.equal(health.at(-1).issueCount, 0); assert.deepEqual((await request('/api/state')).body.windows, []);
  unsubscribe(); await plugin.close(); assert.equal(client.closed, true);
});

test('an original CDP error stays visible rather than becoming a generic readiness timeout', async t => {
  const error = new TypeError('fixture connection rejected');
  const { request, logs } = await fixture(t, async () => { throw error; });
  await new Promise(resolve => setImmediate(resolve));
  const state = (await request('/api/state')).body;
  assert.equal(state.errors[0].message, error.message); assert.equal(state.errors[0].stack, error.stack);
  assert.equal(logs[0].name, 'TypeError');
});

test('a successful broadcast clears only the matching acknowledged operation without a new renderer report', async t => {
  let fail = true, acknowledge = true;
  const client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'main', type: 'page', url: 'app://codex/' }],
    async send(method, params) {
      if (method === 'Target.attachToTarget') return { sessionId: 'main-session' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
      if (method === 'Runtime.evaluate' && params.expression.includes('?.setHostState(') && fail) throw new TypeError('Original delivery failure');
      return { result: { value: acknowledge ? true : undefined } };
    }, async close() { this.closed = true; } };
  const { request, subscribers } = await fixture(t, async () => client);
  await new Promise(resolve => setImmediate(resolve));
  const emit = value => Promise.all([...client.handlers].map(handler => handler({ method: 'Runtime.bindingCalled', sessionId: 'main-session', params: { name: '__CDTK_CHAT_BRIDGE__', payload: JSON.stringify(value) } })));
  await emit({ kind: 'state', applicable: true, errors: [{ source: 'timer', message: 'Unrelated timer error' }] });
  const broadcast = () => { for (const listener of subscribers) listener({ managerUrl: null, health: { plugins: [] } }); };
  const state = async () => (await request('/api/state')).body;
  broadcast(); await new Promise(resolve => setImmediate(resolve));
  assert.ok((await state()).errors.some(error => error.id === 'delivery:main:setHostState'));
  await emit({ kind: 'usage', snapshot: { weekly: { remainingPercent: 60, resetAt: 1900000000000 }, updatedAt: 1899000000000 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok((await state()).errors.some(error => error.id === 'delivery:main:setHostState'), 'another operation cannot clear it');
  fail = false; acknowledge = false; broadcast(); await new Promise(resolve => setImmediate(resolve));
  assert.ok((await state()).errors.some(error => error.id === 'delivery:main:setHostState'), 'missing renderer cannot acknowledge recovery');
  acknowledge = true; broadcast(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await state()).errors.map(error => error.message), ['Unrelated timer error']);
});

test('recovery redelivers each failed state operation without reinstalling the healthy renderer', async t => {
  let failing = true, scripts = 0;
  const client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'main', type: 'page', url: 'app://codex/' }], async send(method, params) {
    if (method === 'Target.attachToTarget') return { sessionId: 'main-session' };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') { scripts++; return { identifier: 'script' }; }
    if (method === 'Runtime.evaluate' && /\?\.set(?:Usage|HardReset)\(/.test(params.expression) && failing) throw new Error('Original state delivery failed');
    return { result: { value: true } };
  }, async close() { this.closed = true; } };
  const { plugin, request } = await fixture(t, async () => client);
  const emit = value => Promise.all([...client.handlers].map(handler => handler({ method: 'Runtime.bindingCalled', sessionId: 'main-session', params: { name: '__CDTK_CHAT_BRIDGE__', payload: JSON.stringify(value) } })));
  await new Promise(resolve => setImmediate(resolve));
  await emit({ kind: 'usage', snapshot: { updatedAt: 1, weekly: { remainingPercent: 60, resetAt: 1900000000000 } } });
  await emit({ kind: 'state', applicable: true, errors: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await request('/api/state')).body.errors.map(value => value.id).sort(), ['delivery:main:setHardReset', 'delivery:main:setUsage']);
  failing = false; await plugin.recover();
  assert.deepEqual((await request('/api/state')).body.errors, []); assert.equal(scripts, 1);
});

test('forecast recovery keeps one polling chain after repeated failures and after success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let calls = 0, failing = true;
  const client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'main', type: 'page', url: 'app://codex/' }], async send(method) {
    if (method === 'Target.attachToTarget') return { sessionId: 'session' };
    return { result: { value: true }, identifier: 'script' };
  }, async close() { this.closed = true; } };
  const { plugin, request } = await fixture(t, async () => client, { hardResetFetch: async () => { calls++; if (failing) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); return Response.json({ data: { scheduled_reset: null } }); } });
  await new Promise(resolve => setImmediate(resolve));
  for (const handler of client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'session', params: { name: '__CDTK_CHAT_BRIDGE__', payload: JSON.stringify({ kind: 'state', applicable: true, errors: [] }) } });
  await new Promise(resolve => setImmediate(resolve));
  await Promise.all([plugin.recover(), plugin.recover()]);
  await plugin.recover();
  assert.ok((await request('/api/state')).body.errors.some(value => value.id === 'hard-reset'));
  failing = false; await plugin.recover();
  const recoveredCalls = calls; t.mock.timers.tick(600000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, recoveredCalls + 1);
  assert.ok(!(await request('/api/state')).body.errors.some(value => value.id === 'hard-reset'));
  await plugin.close(); t.mock.timers.tick(1200000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, recoveredCalls + 1);
});

test('a failed handshake is not broadcast to and check retries the missing target', async t => {
  const calls = [], original = new TypeError('original page initialization failure'); let attempts = 0;
  const client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'main', type: 'page', url: 'app://codex/' }],
    async send(method, params) {
      calls.push(method);
      if (method === 'Target.attachToTarget') return { sessionId: 'session-' + ++attempts };
      if (method === 'Runtime.enable' && attempts === 1) throw original;
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
      if (method === 'Runtime.evaluate') return { result: { value: {} } };
      return {};
    }, async close() { this.closed = true; } };
  const { plugin, request, subscribers } = await fixture(t, async () => client);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request('/api/state')).body.errors[0].stack, original.stack);
  for (const listener of subscribers) listener({ managerUrl: null, health: { plugins: [] } });
  assert.equal(calls.includes('Runtime.evaluate'), false);
  assert.equal(calls.filter(value => value === 'Target.detachFromTarget').length, 1);
  await plugin.check();
  assert.equal(attempts, 2); assert.deepEqual((await request('/api/state')).body.errors, []);
});

test('a valid late renderer report clears its recovered target error but keeps real feature errors', async t => {
  const original = Object.assign(new Error('CDP command timed out: Runtime.evaluate'), { code: 'CDP_COMMAND_TIMEOUT' });
  const client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'main', type: 'page', url: 'app://codex/' }],
    async send(method) {
      if (method === 'Target.attachToTarget') return { sessionId: 'main-session' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
      if (method === 'Runtime.evaluate') throw original;
      return {};
    }, async close() { this.closed = true; } };
  const { request, health } = await fixture(t, async () => client);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request('/api/state')).body.errors[0].message, original.message);
  for (const handler of client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'main-session', params: { name: '__CDTK_CHAT_BRIDGE__', payload: JSON.stringify({ kind: 'state', applicable: false, errors: [{ source: 'timer', message: 'Current timer error' }] }) } });
  assert.deepEqual((await request('/api/state')).body.errors.map(error => error.message), ['Current timer error']);
  assert.equal(health.at(-1).issueCount, 1);
  client.send = async () => ({});
});

test('optional public forecast waits for the app and cannot prevent cold startup', async () => {
  let fetched = 0;
  const lifetime = { cdp: { onReconnect: () => () => {}, acquire: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
    log: async () => {}, setHealth: value => assert.equal(value.ok, true), onHostState: () => () => {} };
  const plugin = await chatPlugin({}, { hardResetFetch: async () => { fetched++; throw new Error('Must not fetch before the app'); } }).start(lifetime);
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(fetched, 0); }
  finally { await plugin.close(); }
});
