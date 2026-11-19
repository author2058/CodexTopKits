import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCdpService, initializePage } from '../src/cdp.mjs';
import { createPluginHost } from '../src/index.mjs';
import { startRuntime, requestRuntime } from '../src/runtime.mjs';

function browser(t, { discoveryUrl, fetchError, methodError, stall } = {}) {
  const sockets = [], commands = [];
  let fetches = 0, sequence = 0;
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor(url) {
      super(); this.url = String(url); this.readyState = 0; sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })); }
    send(bytes) {
      const command = JSON.parse(bytes); commands.push(command);
      if (command.method === 'Runtime.stall' || stall?.(command)) return;
      queueMicrotask(() => {
        const error = methodError?.(command);
        let result = {};
        if (command.method === 'Target.getTargets') result = { targetInfos: [{ targetId: 'main', type: 'page', url: 'app://codex/' }] };
        if (command.method === 'Target.attachToTarget') result = { sessionId: 'session-' + ++sequence };
        this.message({ id: command.id, ...(error ? { error } : { result }) });
        if (command.method === 'Tracing.end' && !error) this.message({ method: 'Tracing.tracingComplete', params: {} });
      });
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: Socket });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', original));
  t.mock.method(globalThis, 'fetch', async url => {
    fetches++;
    if (fetchError) throw fetchError;
    const address = new URL(url);
    assert.equal(address.hostname, '127.0.0.1');
    return Response.json({ webSocketDebuggerUrl: discoveryUrl || `ws://127.0.0.1:${address.port}/devtools/browser/fixture` });
  });
  return { sockets, commands, get fetches() { return fetches; } };
}

test('page initialization releases a partial session and retains the protocol error', async t => {
  const fixture = browser(t, { methodError: command => command.method === 'Page.enable' ? { code: 17, message: 'original handshake failure', data: 'unchanged' } : null });
  const service = await createCdpService([12345]); t.after(() => service.close());
  const client = await service.forOwner('page').acquire();
  await assert.rejects(initializePage(client, 'main', 'fixtureBinding'), error => error.code === 17 && error.message === 'original handshake failure' && error.data === 'unchanged');
  assert.equal(client.sessions.size, 0);
  assert.equal(fixture.commands.filter(command => command.method === 'Target.detachFromTarget').length, 1);
  assert.equal(fixture.commands.filter(command => command.method === 'Runtime.addBinding').length, 0);
  assert.equal(fixture.sockets.length, 1, 'unknown protocol errors never trigger automatic reconnect');
});

test('an unusable open session gets one recovery, without replay or a timeout loop', async t => {
  const fixture = browser(t), service = await createCdpService([12345]); t.after(() => service.close());
  const owner = service.forOwner('page'), first = await owner.acquire(), done = Promise.withResolvers();
  let resumed = 0;
  owner.onReconnect(async () => {
    resumed++;
    const second = await owner.acquire();
    await initializePage(second, 'main', 'fixtureBinding');
    // A failed recovery must remain visible instead of starting another loop.
    await assert.rejects(second.send('Runtime.stall', {}, undefined, 1), error => error.code === 'CDP_COMMAND_TIMEOUT');
    done.resolve(second);
  });
  await assert.rejects(first.send('Runtime.stall', {}, undefined, 1), error => error.code === 'CDP_COMMAND_TIMEOUT');
  const second = await done.promise;
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(second.send('Runtime.stall', {}, undefined, 1), error => error.code === 'CDP_COMMAND_TIMEOUT');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.closed, true); assert.equal(second.closed, false);
  assert.equal(resumed, 1); assert.equal(fixture.sockets.length, 2);
  assert.equal(fixture.commands.filter(command => command.method === 'Runtime.stall').length, 3);
});

test('background component retries preserve the shared timeout recovery budget; explicit reconnect can rearm it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = browser(t), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-timeout-retry-'));
  let client, retries = 0;
  const host = await createPluginHost({ stateDirectory: directory, plugins: [{ id: 'page', coreApiVersion: 1, cdpPort: 'auto',
    async start(context) {
      const connect = async () => {
        client = await context.cdp.acquire();
        client.onError = error => context.setHealth({ ok: false, message: error.message });
        await initializePage(client, 'main', 'fixtureBinding');
      };
      const unsubscribe = context.cdp.onReconnect(connect);
      await connect(); context.setHealth({ ok: true, message: 'Connected.' });
      return {
        async recover() { retries++; await client.send('Runtime.stall', {}, undefined, 1); },
        async close() { unsubscribe(); await client.close(); },
      };
    },
  }] });
  t.after(async () => { await host.close(); await fs.rm(directory, { recursive: true }); });
  const timeout = () => assert.rejects(client.send('Runtime.stall', {}, undefined, 1), error => error.code === 'CDP_COMMAND_TIMEOUT');
  const first = timeout(); t.mock.timers.tick(1); await first;
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.sockets.length, 2);
  for (let attempt = 1; attempt <= 3; attempt++) {
    t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve));
    assert.equal(retries, attempt, 'component retries continue after the shared recovery is used');
    assert.equal(fixture.sockets.length, 2, 'background retries must not tear down the shared connection again');
    assert.equal(client.closed, false);
  }
  await host.reconnect();
  const manual = timeout(); t.mock.timers.tick(1); await manual;
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.sockets.length, 3, 'explicit user reconnect retains its recovery authority');
});

test('timeout diagnostics identify the operation without retaining expressions or user data', async t => {
  const fixture = browser(t, { stall: command => command.method === 'Runtime.evaluate' }), diagnostics = [];
  const service = await createCdpService([12345], { onDiagnostic: value => diagnostics.push(value) }); t.after(() => service.close());
  const client = await service.forOwner('chat').acquire();
  const { sessionId } = await client.send('Target.attachToTarget', { targetId: 'main', flatten: true });
  const expression = 'window["__CODEX_DESKTOP_TOOLKIT_CHAT__"]?.setUsage({"text":"private fixture body"})';
  await assert.rejects(client.send('Runtime.evaluate', { expression, awaitPromise: true }, sessionId, 1), error => {
    assert.equal(error.code, 'CDP_COMMAND_TIMEOUT'); assert.equal(error.message, 'CDP command timed out: Runtime.evaluate');
    assert.equal(error.command.operation, 'setUsage'); return true;
  });
  assert.equal(diagnostics.length, 1);
  const record = diagnostics[0];
  assert.equal(record.event, 'cdp-command-timeout'); assert.equal(record.owner, 'chat'); assert.equal(record.targetId, 'main');
  assert.equal(record.targetType, 'page'); assert.equal(record.sessionId, sessionId); assert.equal(record.awaitPromise, true);
  assert.equal(record.expressionChars, expression.length); assert.equal(record.timeoutMs, 1); assert.ok(record.elapsedMs >= 0);
  assert.ok(!JSON.stringify(record).includes('private fixture body')); assert.equal('expression' in record, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.commands.filter(command => command.method === 'Runtime.evaluate').length, 1, 'no command replay');
});

test('disconnect invalidates every owner before health callbacks can broadcast to another lease', async t => {
  const fixture = browser(t), service = await createCdpService([12345]); t.after(() => service.close());
  const first = await service.forOwner('first').acquire(), second = await service.forOwner('second').acquire();
  const rejected = Promise.withResolvers();
  first.onError = () => {
    assert.equal(second.closed, true);
    assert.rejects(second.send('Runtime.stall'), error => error.code === 'CDP_CONSUMER_CLOSED' && /consumer is closed/.test(error.message)).then(rejected.resolve, rejected.reject);
  };
  fixture.sockets[0].close();
  await rejected.promise;
  assert.equal(fixture.commands.some(command => command.method === 'Runtime.stall'), false);
});

test('confirmed application exit aborts a stalled trace without retrying or waiting for its timeout', async t => {
  const fixture = browser(t, { stall: command => command.method === 'Tracing.end' });
  const service = await createCdpService([12345]); t.after(() => service.close());
  const client = await service.forOwner('traffic').acquire();
  await client.send('Tracing.start');
  const pending = assert.rejects(client.send('Tracing.end', {}, undefined, 60000), error => error.code === 'CDP_DISCONNECTED');
  service.applicationExited();
  await pending;
  assert.equal(client.closed, true);
  assert.equal(service.status().connected, false);
  assert.equal(fixture.commands.filter(command => command.method === 'Tracing.end').length, 1);
  assert.equal(fixture.sockets.length, 1);
  await service.close();
});

test('host shutdown invalidates CDP before plugin cleanup only when application exit is confirmed', async t => {
  const fixture = browser(t), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-app-exit-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  let client, wasClosed;
  const host = await createPluginHost({ stateDirectory: directory, plugins: [{ id: 'traffic', coreApiVersion: 1, cdpPort: 'auto',
    async start(context) {
      client = await context.cdp.acquire(); await client.send('Tracing.start');
      return { async close() { wasClosed = client.closed; if (!client.closed) await client.send('Tracing.end'); await client.close(); } };
    },
  }] });
  await host.close({ applicationExited: true });
  assert.equal(wasClosed, true);
  assert.equal(fixture.commands.some(command => command.method === 'Tracing.end'), false);
});

test('the authenticated stop command forwards confirmed application exit to the CDP owner', async t => {
  const fixture = browser(t), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-exit-command-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  let client, wasClosed;
  const runtime = await startRuntime({ stateDirectory: directory, plugins: [{ id: 'traffic', coreApiVersion: 1, cdpPort: 'auto',
    async start(context) {
      client = await context.cdp.acquire(); await client.send('Tracing.start');
      return { async close() { wasClosed = client.closed; if (!client.closed) await client.send('Tracing.end'); await client.close(); } };
    },
  }] });
  t.after(() => runtime.close());
  assert.equal((await requestRuntime(directory, 'stop', { applicationExited: true })).phase, 'stopped');
  await runtime.close();
  assert.equal(wasClosed, true);
  assert.equal(fixture.commands.some(command => command.method === 'Tracing.end'), false);
});

test('explicit reconnect coalesces with automatic reconnect and notifies each owner once', async t => {
  const fixture = browser(t), service = await createCdpService(['auto']);
  t.after(() => service.close());
  const owner = service.forOwner('fixture');
  let resumed = 0;
  owner.onReconnect(() => { resumed++; });
  const first = await owner.acquire();
  assert.equal(resumed, 0);
  fixture.sockets[0].close();
  await Promise.all([service.reconnect(), service.reconnect()]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.closed, true);
  assert.equal(fixture.sockets.length, 2);
  assert.equal(resumed, 1);
  await service.reconnect();
  assert.equal(fixture.sockets.length, 2);
  assert.equal(resumed, 1);
});

test('an explicit launch can reconnect after a previous automatic attempt has already failed', async t => {
  const fixture = browser(t), service = await createCdpService(['auto']);
  t.after(() => service.close());
  const owner = service.forOwner('fixture'), first = await owner.acquire();
  const failure = new SyntaxError('fixture discovery unavailable'), failed = Promise.withResolvers();
  let resumed = 0;
  owner.onReconnect(() => { resumed++; });
  first.onError = error => { if (error === failure) failed.resolve(); };
  const broken = t.mock.method(globalThis, 'fetch', async () => { throw failure; });
  fixture.sockets[0].close();
  await failed.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed, 0);
  assert.equal(fixture.sockets.length, 1);
  broken.mock.restore();
  await service.reconnect();
  assert.equal(resumed, 1);
  assert.equal(fixture.sockets.length, 2);
});

test('one host shares browser discovery and connection; consumer sessions and cleanup stay separate', async t => {
  const fixture = browser(t), contexts = [];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-cdp-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const host = await createPluginHost({ stateDirectory: directory, plugins: ['themes', 'traffic'].map(id => ({
    id, coreApiVersion: 1, cdpPort: 'auto', async start(context) {
      contexts.push(context);
      return { close: async () => { const client = await context.cdp.acquire(); await client.close(); } };
    },
  })) });
  t.after(() => host.close());
  assert.equal(fixture.fetches, 0, 'CDP is lazy, so service startup does not wait for the app');
  assert.equal(contexts[0].cdp.port, contexts[1].cdp.port);
  assert.deepEqual(host.launchEnvironment, { CODEX_TOOLKIT_CDP_PORT: String(contexts[0].cdp.port) });
  const [first, second] = await Promise.all(contexts.map(context => context.cdp.acquire()));
  assert.equal(fixture.sockets.length, 1);
  assert.equal(fixture.fetches, 1);
  assert.equal(fixture.commands.filter(command => command.method === 'Target.getTargets').length, 1);
  const a = await first.send('Target.attachToTarget', { targetId: 'main', flatten: true });
  const b = await second.send('Target.attachToTarget', { targetId: 'main', flatten: true });
  const received = [[], []];
  first.handlers.add(message => received[0].push(message)); second.handlers.add(message => received[1].push(message));
  fixture.sockets[0].message({ method: 'Network.fixture', sessionId: b.sessionId, params: {} });
  assert.equal(received[0].length, 0); assert.equal(received[1].length, 1);
  await assert.rejects(first.send('Runtime.enable', {}, b.sessionId), /another consumer/);
  fixture.sockets[0].message({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'second', type: 'page', url: 'app://codex/new' } } });
  assert.equal(first.targets().length, 2); assert.equal(second.targets().length, 2);
  fixture.sockets[0].message({ method: 'Target.targetDestroyed', params: { targetId: 'second' } });
  assert.equal(first.targets().length, 1);
  await first.close();
  assert.deepEqual(fixture.commands.filter(command => command.method === 'Target.detachFromTarget').map(command => command.params.sessionId), [a.sessionId]);
  assert.equal(fixture.sockets[0].readyState, 1);
  await second.send('Runtime.enable', {}, b.sessionId);
  await host.close();
  assert.equal(fixture.sockets[0].readyState, 3);
});

test('port conflicts and invalid ports fail before a plugin starts', async t => {
  const fixture = browser(t);
  await assert.rejects(createCdpService([12345, 12346]), /different CDP ports/);
  await assert.rejects(createCdpService([0]), /CDP port/);
  const service = await createCdpService(['auto', 12345]);
  assert.equal(service.port, 12345);
  await service.close();
  assert.equal(fixture.fetches, 0);
});

test('failed plugin startup releases its CDP sessions without replacing the original error', async t => {
  const fixture = browser(t), original = new Error('fixture startup failed after attaching');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-cdp-startup-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  await assert.rejects(createPluginHost({ stateDirectory: directory, plugins: [{ id: 'fixture', coreApiVersion: 1, cdpPort: 12345,
    async start(context) { const client = await context.cdp.acquire(); await client.send('Target.attachToTarget', { targetId: 'main' }); throw original; },
  }] }), error => error === original);
  assert.equal(fixture.commands.filter(command => command.method === 'Target.detachFromTarget').length, 1);
  assert.equal(fixture.sockets[0].readyState, 3);
});

test('browser Tracing has one owner and a consumer cannot end another trace', async t => {
  browser(t);
  const service = await createCdpService([12345]); t.after(() => service.close());
  const first = await service.forOwner('traffic').acquire(), second = await service.forOwner('themes').acquire();
  await first.send('Tracing.start');
  await assert.rejects(second.send('Tracing.start'), /already owned by traffic/);
  await assert.rejects(second.send('Tracing.end'), /another consumer/);
  await assert.rejects(first.close(), /End the owned browser trace/);
  await first.send('Tracing.end'); await first.close();
  await second.send('Tracing.start'); await second.send('Tracing.end'); await second.close();
});

test('an unacknowledged trace start retains its owner until that same session ends', async t => {
  let stallStart = true;
  const fixture = browser(t, { stall: command => command.method === 'Tracing.start' && stallStart });
  const service = await createCdpService([12345]); t.after(() => service.close());
  const owner = service.forOwner('traffic'), first = await owner.acquire(), resumed = Promise.withResolvers();
  owner.onReconnect(async () => resumed.resolve(await owner.acquire()));
  await assert.rejects(first.send('Runtime.stall', {}, undefined, 1), error => error.code === 'CDP_COMMAND_TIMEOUT');
  const current = await resumed.promise; await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(current.send('Tracing.start', {}, undefined, 1), error => error.code === 'CDP_COMMAND_TIMEOUT');
  assert.equal(current.traceState, 'uncertain');
  const other = await service.forOwner('other').acquire();
  await assert.rejects(other.send('Tracing.start'), /already owned by traffic/);
  await assert.rejects(other.send('Tracing.end'), /another consumer/);
  await assert.rejects(current.close(), /End the owned browser trace/);
  const original = fixture.commands.findLast(command => command.method === 'Tracing.start');
  fixture.sockets.at(-1).message({ id: original.id, result: {} });
  assert.equal(current.traceState, 'uncertain', 'a late acknowledgement cannot release the owned capture');
  await current.send('Tracing.end'); assert.equal(current.traceState, 'idle');
  stallStart = false; await other.send('Tracing.start'); assert.equal(other.traceState, 'active');
  await other.send('Tracing.end'); assert.equal(other.traceState, 'idle');
  assert.equal(fixture.sockets.length, 2, 'reconciling a trace never adds another CDP connection');
});

test('an explicit not-started response releases only the ending owner', async t => {
  browser(t, { methodError: command => command.method === 'Tracing.end' ? { code: -32000, message: 'Tracing is not started' } : null });
  const service = await createCdpService([12345]); t.after(() => service.close());
  const client = await service.forOwner('traffic').acquire();
  await client.send('Tracing.start');
  await assert.rejects(client.send('Tracing.end'), error => error.code === -32000 && error.message === 'Tracing is not started');
  assert.equal(client.traceState, 'idle'); await client.close();
});

test('detaching one session cancels only that session; closing a target cancels its remaining work', async t => {
  const fixture = browser(t), service = await createCdpService([12345]); t.after(() => service.close());
  const first = await service.forOwner('first').acquire(), second = await service.forOwner('second').acquire();
  const a = await first.send('Target.attachToTarget', { targetId: 'main' }), b = await second.send('Target.attachToTarget', { targetId: 'main' });
  const firstPending = assert.rejects(first.send('Runtime.stall', {}, a.sessionId), error => error.code === 'CDP_TARGET_CLOSED');
  const secondPending = assert.rejects(second.send('Runtime.stall', {}, b.sessionId), error => error.code === 'CDP_TARGET_CLOSED');
  fixture.sockets[0].message({ method: 'Target.detachedFromTarget', params: { sessionId: a.sessionId } });
  await firstPending;
  await assert.rejects(first.send('Runtime.enable', {}, a.sessionId), error => error.code === 'CDP_TARGET_CLOSED');
  await assert.rejects(first.send('Target.detachFromTarget', { sessionId: a.sessionId }), error => error.code === 'CDP_TARGET_CLOSED');
  await assert.rejects(second.send('Runtime.enable', {}, a.sessionId), error => /another consumer/.test(error.message) && error.code !== 'CDP_TARGET_CLOSED');
  await second.send('Runtime.enable', {}, b.sessionId);
  fixture.sockets[0].message({ method: 'Target.targetDestroyed', params: { targetId: 'main' } });
  await secondPending;
  await assert.rejects(second.send('Runtime.enable', {}, b.sessionId), error => error.code === 'CDP_TARGET_CLOSED');
  assert.equal(first.sessions.size, 0); assert.equal(second.sessions.size, 0);
});

test('a target closing during owned session cleanup is expected; other protocol failures still escape', async t => {
  let fixture, race = true;
  fixture = browser(t, { methodError: command => {
    if (command.method === 'Target.detachFromTarget') {
      if (!race) return { code: 17, message: 'original cleanup failure', data: 'unchanged diagnostic' };
      fixture.sockets[0].message({ method: 'Target.targetDestroyed', params: { targetId: 'main' } });
    }
    return null;
  } });
  const service = await createCdpService([12345]); t.after(() => service.close());
  const client = await service.forOwner('cleanup').acquire();
  await client.send('Target.attachToTarget', { targetId: 'main' });
  await client.close(); assert.equal(client.closedSessions.size, 0);
  race = false;
  const unexpected = await service.forOwner('unexpected').acquire();
  await unexpected.send('Target.attachToTarget', { targetId: 'replacement' });
  await assert.rejects(unexpected.close(), error => error instanceof AggregateError && error.errors[0].code === 17 && error.errors[0].data === 'unchanged diagnostic');
});

test('CDP protocol errors retain their code and data; a failed trace start releases ownership', async t => {
  let rejected = false;
  browser(t, { methodError: command => command.method === 'Tracing.start' && !rejected++ ? { code: -32000, message: 'fixture trace failure', data: 'original diagnostic' } : null });
  const service = await createCdpService([12345]); t.after(() => service.close());
  const first = await service.forOwner('first').acquire(), second = await service.forOwner('second').acquire();
  await assert.rejects(first.send('Tracing.start'), error => error.code === -32000 && error.message === 'fixture trace failure' && error.data === 'original diagnostic');
  await second.send('Tracing.start'); await second.send('Tracing.end');
});

test('malformed messages expose the original parse error and reject pending commands', async t => {
  const fixture = browser(t), errors = [];
  const service = await createCdpService([12345]); t.after(() => service.close());
  const client = await service.forOwner('fixture').acquire(); client.onError = error => errors.push(error);
  const rejected = assert.rejects(client.send('Runtime.stall'), SyntaxError);
  fixture.sockets[0].message('NOT JSON'); await rejected;
  assert.ok(errors[0] instanceof SyntaxError);
  assert.equal(errors.length, 1);
});

test('discovery identity and unexpected discovery errors are not retried or hidden', async t => {
  const original = new SyntaxError('fixture discovery failure');
  const fixture = browser(t, { fetchError: original });
  const service = await createCdpService([12345]); t.after(() => service.close());
  await assert.rejects(service.forOwner('fixture').acquire(), error => error === original);
  assert.equal(fixture.fetches, 1); assert.equal(fixture.sockets.length, 0);
});

test('a debugger URL cannot escape the configured loopback endpoint', async t => {
  const fixture = browser(t, { discoveryUrl: 'ws://example.com:12345/devtools/browser/fixture' });
  const service = await createCdpService([12345]); t.after(() => service.close());
  await assert.rejects(service.forOwner('fixture').acquire(), /Rejected CDP endpoint/);
  assert.equal(fixture.sockets.length, 0);
});

test('a consumer can stop waiting for app startup without cancelling the host connection', async t => {
  browser(t, { fetchError: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) });
  const service = await createCdpService([12345]);
  const abort = new AbortController(), original = new Error('owned consumer cancellation');
  const waiting = service.forOwner('fixture').acquire({ signal: abort.signal });
  abort.abort(original);
  await assert.rejects(waiting, error => error === original);
  await service.close();
});

test('a stale consumer cannot remove the replacement lease or observe its new socket', async t => {
  const fixture = browser(t), service = await createCdpService([12345]); t.after(() => service.close());
  const access = service.forOwner('fixture'), old = await access.acquire();
  fixture.sockets[0].close();
  const replacement = await access.acquire(), messages = [];
  replacement.handlers.add(message => messages.push(message));
  await old.close();
  fixture.sockets[1].message({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'new', type: 'page', url: 'app://codex/new' } } });
  assert.equal(messages.length, 1);
  assert.notEqual(old.socket, replacement.socket); assert.equal(old.socket.readyState, 3); assert.equal(replacement.socket.readyState, 1);
});

test('an established browser restart drops orphaned reports and notifies all owners after one shared reconnect', async t => {
  const fixture = browser(t), service = await createCdpService([12345]); t.after(() => service.close());
  const access = [service.forOwner('chat'), service.forOwner('voice')], clients = await Promise.all(access.map(value => value.acquire()));
  const lost = [], reopened = [], snapshots = [];
  for (const [index, client] of clients.entries()) {
    client.handlers.add(message => { if (message.toolkitDisconnect) lost.push([index, message.params.targetId, client.closed]); });
    client.onError = error => snapshots.push(error.code);
    access[index].onReconnect(async () => { const fresh = await access[index].acquire(); reopened.push([index, fresh, fresh.targets().map(row => row.targetId)]); });
  }
  const waiting = assert.rejects(clients[0].send('Runtime.stall'), error => error.code === 'CDP_DISCONNECTED');
  fixture.sockets[0].close(); await waiting;
  for (let index=0; index<4; index++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lost, [[0,'main',true],[1,'main',true]]); assert.deepEqual(snapshots, ['CDP_DISCONNECTED','CDP_DISCONNECTED']);
  assert.equal(fixture.sockets.length, 2); assert.equal(fixture.fetches, 2); assert.equal(reopened.length, 2);
  assert.ok(reopened.every(([index, fresh, targets]) => fresh !== clients[index] && !fresh.closed && targets[0] === 'main'));
});

test('reconnect subscription stops with its owner and unexpected protocol failures do not auto-retry', async t => {
  const fixture = browser(t), service = await createCdpService([12345]); t.after(() => service.close());
  const access = service.forOwner('voice'); let callbacks = 0;
  const unsubscribe = access.onReconnect(() => callbacks++); const client = await access.acquire(); unsubscribe();
  fixture.sockets[0].close(); await new Promise(resolve => setImmediate(resolve)); assert.equal(callbacks, 0);
  await access.acquire(); const before = fixture.fetches;
  fixture.sockets.at(-1).message('NOT JSON'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.fetches, before); assert.equal(client.closed, true);
});

test('a transport error after a healthy connection retains its diagnostic and reconnects, unlike malformed data', async t => {
  const fixture = browser(t), service = await createCdpService([12345]); t.after(() => service.close());
  const access = service.forOwner('chat'), client = await access.acquire(), original = new Error('transport reset');
  const errors = []; client.onError = value => errors.push(value);
  let connected = 0; access.onReconnect(() => connected++);
  const event = new Event('error'); Object.defineProperty(event, 'error', { value: original }); fixture.sockets[0].dispatchEvent(event);
  for (let index=0; index<4; index++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors[0], original); assert.equal(fixture.sockets.length, 2); assert.equal(connected, 1);
});

test('an unexpected reconnect discovery failure reaches the original owner and is not retried', async t => {
  const fixture = browser(t), service = await createCdpService([12345]); t.after(() => service.close());
  const access = service.forOwner('voice'), client = await access.acquire(), original = new SyntaxError('new discovery schema is invalid'), errors=[];
  access.onReconnect(() => assert.fail('Invalid discovery must not invoke consumers')); client.onError=error=>errors.push(error);
  t.mock.method(globalThis,'fetch',async()=>{throw original;});fixture.sockets[0].close();
  for(let index=0;index<4;index++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(errors.at(-1),original);assert.equal(fixture.sockets.length,1);
});
