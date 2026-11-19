import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { kitModule } from 'codex-toolkit-core/kits';
import kitRuntime from 'codex-toolkit-core/kit-runtime';
import kit from '../kits/update-restart-protection/index.mjs';
import { createRestartProtection } from '../src/restart-protection.mjs';
import createRestartProtectionService from '../src/restart-protection-service.mjs';

function fixture(results) {
  let now = 0; const calls = [], logs = [], waits = [], confirmed = { pid: 123, registered: true, hookInstalled: true, hookVerified: true };
  const control = createRestartProtection({ processId: 123, port: 51111, powershellPath: 'pwsh', signal: new AbortController().signal, log: async value => logs.push(value) }, {
    now: () => now, sleep: async ms => { now += ms; waits.push(ms); }, execute: async (...args) => {
      calls.push(args); const result = results.shift() ?? confirmed; if (result instanceof Error) throw result;
      return { stdout: typeof result === 'string' ? result : JSON.stringify(result) };
    },
  });
  return { control, calls, logs, waits, confirmed };
}

test('restart protection coalesces callers and passes exact PID, loopback port and UTF-8 contract', async () => {
  const f = fixture([]); const [a, b] = await Promise.all([f.control.protect(), f.control.protect()]);
  assert.deepEqual(a, f.confirmed); assert.equal(a, b); assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0][1].includes('123')); assert.ok(f.calls[0][1].includes('51111')); assert.equal(f.calls[0][2].encoding, 'utf8'); assert.equal(f.calls[0][2].windowsHide, true);
  assert.deepEqual(f.control.status(), f.confirmed); assert.equal(f.logs[0].event, 'restart-registration-confirmed');
});

test('only Windows not-yet-registered waits within the existing sixty-second startup allowance', async () => {
  const pending = { error: { code: 'RESTART_NOT_REGISTERED', message: 'original pending', name: 'COMException', stack: 'native stack', hresult: '0x80070490' } };
  const f = fixture([pending, pending]); await f.control.protect(); assert.deepEqual(f.waits, [1000, 1000]); assert.equal(f.logs.filter(row => row.event === 'restart-registration-pending').length, 1);
  const expired = fixture(Array(61).fill(pending)); await assert.rejects(expired.control.protect(), error => error.code === pending.error.code && error.stack === 'native stack');
  assert.equal(expired.waits.reduce((a, b) => a + b, 0), 60000); assert.equal(expired.control.status().registered, false);
});

test('unexpected process failures, schema failures and unverified guards never retry or light green', async () => {
  const original = new TypeError('access failed'), failure = fixture([original]);
  await assert.rejects(failure.control.protect(), error => error === original); await assert.rejects(failure.control.protect(), error => error === original); assert.equal(failure.calls.length, 1);
  for (const value of ['not JSON', { pid: 456, registered: true, hookInstalled: true, hookVerified: true }, { pid: 123, registered: true, hookInstalled: false, hookVerified: false }]) {
    const f = fixture([value]); await assert.rejects(f.control.protect()); assert.equal(f.waits.length, 0); assert.equal(f.control.status().registered, false);
  }
});

test('update protection service reuses the legacy guard and preserves its error', async () => {
  const original = new TypeError('Original guard failure'); let fail = false, reply;
  const service = await createRestartProtectionService({ legacyPlugin: 'windows' }, {
    getPlugin: () => ({ protectRestart() { if (fail) throw original; return { registered: true, hookInstalled: true, hookVerified: true }; } }),
    evaluatePage: async (_id, expression) => vm.runInNewContext(expression, { window: { __CODEXTOPKITS_RESTART_PROTECTION__: { resolve: (...args) => { reply = args; } } } }),
  });
  assert.equal(await service.receive('page', { kind: 'other' }), false);
  await service.receive('page', { kind: 'restart-protection', requestId: 'one' });
  assert.equal(reply[0], 'one'); assert.equal(reply[1].hookVerified, true); assert.equal(reply[2], null);
  fail = true; await service.receive('page', { kind: 'restart-protection', requestId: 'two' });
  assert.equal(reply[0], 'two'); assert.equal(reply[1], null); assert.equal(reply[2].name, 'TypeError'); assert.equal(reply[2].message, original.message);
  await assert.rejects(service.receive('page', { kind: 'restart-protection' }), /request identity/);
  await service.close();
});

test('Kit runtime provides the active CDP port to the standalone guard without modifying a process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-restart-kit-')), artifact = path.join(root, 'artifact');
  await fs.mkdir(artifact); await fs.writeFile(path.join(artifact, 'kit.json'), JSON.stringify(kit.manifest), 'utf8');
  await fs.writeFile(path.join(artifact, 'index.mjs'), kitModule(kit), 'utf8');
  let guardOptions, reply;
  const client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'page', type: 'page', url: 'app://index.html' }],
    async send(method, params) {
      if (method === 'SystemInfo.getProcessInfo') return { processInfo: [{ type: 'browser', id: 123 }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
      if (method === 'Runtime.evaluate') {
        if (params.expression.startsWith('window.__CODEXTOPKITS_RESTART_PROTECTION__?.resolve(')) vm.runInNewContext(params.expression, { window: { __CODEXTOPKITS_RESTART_PROTECTION__: { resolve: (...args) => { reply = args; } } } });
        return { result: { value: true } };
      }
      return {};
    }, async close() { this.closed = true; } };
  const context = { stateDirectory: root, cdp: { port: 51111, acquire: async () => client, onReconnect: () => () => {} }, log: async () => {},
    setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  const serviceFactories = { 'restart-protection': Object.assign((options, inner) => createRestartProtectionService(options, inner, { createRestartProtection: value => {
    guardOptions = value; return { protect: async () => ({ registered: true, hookInstalled: true, hookVerified: true }), settled() {} };
  } }), { serviceApiVersion: '1.0.0' }) };
  const runtime = await kitRuntime({ artifacts: [artifact], services: { 'restart-protection': { module: 'codex-toolkit-windows/restart-protection-service' } } }, { serviceFactories }).start(context);
  try {
    await runtime.connect();
    for (const handler of client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'session', params: {
      name: '__CODEXTOPKITS_FEATURE_ACTION__', payload: JSON.stringify({ kind: 'restart-protection', requestId: 'three' }),
    } });
    assert.equal(guardOptions.processId, 123); assert.equal(guardOptions.port, 51111); assert.equal(reply[0], 'three'); assert.equal(reply[1].hookVerified, true);
  } finally { await runtime.close(); await fs.rm(root, { recursive: true }); }
});
