import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startRuntime, requestRuntime } from '../src/runtime.mjs';

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-runtime-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true });
  });
  return root;
}

test('one runtime owns a directory; status, environment and stop use its authenticated pipe', async t => {
  const root = await directory(t);
  let closed = 0;
  const plugin = { id: 'fixture', coreApiVersion: 1, start: async () => ({
    launchEnvironment: { FIXTURE_ROUTE: 'synthetic-route' }, close: async () => { closed++; },
  }) };
  const runtime = await startRuntime({ stateDirectory: root, plugins: [plugin] });
  t.after(() => runtime.close());
  assert.equal((await requestRuntime(root, 'status')).phase, 'running');
  assert.deepEqual((await requestRuntime(root, 'environment')).environment, { FIXTURE_ROUTE: 'synthetic-route' });
  await assert.rejects(startRuntime({ stateDirectory: root }), error => error.code === 'EADDRINUSE');
  assert.equal((await requestRuntime(root, 'stop')).phase, 'stopped');
  await runtime.close();
  assert.equal(closed, 1);
  assert.equal((await requestRuntime(root, 'status')).phase, 'stopped');
  const restarted = await startRuntime({ stateDirectory: root });
  await restarted.close();
});

test('stale metadata cannot stop or impersonate the current runtime', async t => {
  const root = await directory(t);
  const runtime = await startRuntime({ stateDirectory: root });
  t.after(() => runtime.close());
  const filename = path.join(root, 'runtime.json');
  const actual = await fs.readFile(filename, 'utf8'), state = JSON.parse(actual);
  state.token = 'wrong-token';
  await fs.writeFile(filename, JSON.stringify(state), 'utf8');
  await assert.rejects(requestRuntime(root, 'stop'), /identity or access token/);
  await fs.writeFile(filename, actual, 'utf8');
  assert.equal((await requestRuntime(root, 'status')).phase, 'running');
});

test('failed startup releases its owner, preserving the original error', async t => {
  const root = await directory(t), failure = new Error('fixture startup error');
  await assert.rejects(startRuntime({ stateDirectory: root, plugins: [
    { id: 'fixture', coreApiVersion: 1, start: async () => { throw failure; } },
  ] }), error => error === failure);
  const runtime = await startRuntime({ stateDirectory: root });
  await runtime.close();
});

test('malformed state is not reported as stopped or silently discarded', async t => {
  const root = await directory(t);
  assert.equal((await requestRuntime(root, 'status')).phase, 'stopped');
  await fs.writeFile(path.join(root, 'runtime.json'), 'INVALID', 'utf8');
  await assert.rejects(requestRuntime(root, 'status'), SyntaxError);
});

test('stop replies only after asynchronous plugin cleanup, despite the client finishing its request', async t => {
  const root = await directory(t);
  let entered, release;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = await startRuntime({ stateDirectory: root, plugins: [{ id: 'fixture', coreApiVersion: 1,
    start: async () => ({ close: async () => { entered(); await gate; } }),
  }] });
  t.after(() => runtime.close());
  const stopped = requestRuntime(root, 'stop');
  await began;
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.equal((await stopped).phase, 'stopped');
  await runtime.close();
});

test('a failing plugin is reported with nested details and still releases the runtime owner', async t => {
  const root = await directory(t);
  const underlying = Object.assign(new Error('trace flush failed'), { code: 'FIXTURE_TRACE' });
  const original = new AggregateError([underlying], 'Feature runtime cleanup failed.', { cause: underlying });
  const runtime = await startRuntime({ stateDirectory: root, plugins: [{ id: 'fixture', coreApiVersion: 1,
    start: async () => ({ close: async () => { throw original; } }),
  }] });
  t.after(() => runtime.close().catch(() => {}));
  await assert.rejects(requestRuntime(root, 'stop'), error => {
    assert.equal(error.name, 'AggregateError');
    assert.equal(error.message, original.message);
    assert.equal(error.errors[0].code, underlying.code);
    assert.equal(error.errors[0].message, underlying.message);
    assert.equal(error.cause.stack, underlying.stack);
    return true;
  });
  await assert.rejects(runtime.close(), error => error === original);
  assert.equal((await requestRuntime(root, 'status')).phase, 'stopped');
  const next = await startRuntime({ stateDirectory: root });
  await next.close();
});

test('launch reconnection never invokes unrelated plugin diagnostics', async t => {
  const root = await directory(t); let checks = 0;
  const runtime = await startRuntime({ stateDirectory: root, plugins: [{ id: 'diagnostic', coreApiVersion: 1,
    start: async () => ({ close: async () => {}, async check() { checks++; throw new Error('app server is not ready'); } }),
  }] });
  t.after(() => runtime.close());
  assert.equal((await requestRuntime(root, 'reconnect')).phase, 'running');
  assert.equal(checks, 0);
});

test('explicit checks run in the owner without blocking status and retain unexpected errors', async t => {
  const root = await directory(t);
  let release, entered, fail = false;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  const original = Object.assign(new Error('fixture diagnostic failed'), { code: 'FIXTURE_CHECK' });
  const runtime = await startRuntime({ stateDirectory: root, plugins: [{ id: 'diagnostic', coreApiVersion: 1,
    start: async context => ({ close: async () => {}, async check() {
      entered(); await gate;
      if (fail) throw original;
      context.setHealth({ ok: true, message: 'Checked.' });
    } }),
  }] });
  t.after(() => runtime.close());
  const checked = requestRuntime(root, 'check');
  await began;
  assert.equal((await requestRuntime(root, 'status')).phase, 'running');
  release();
  assert.equal((await checked).health.plugins[0].message, 'Checked.');
  fail = true;
  await assert.rejects(requestRuntime(root, 'check'), error => error.code === original.code && error.message === original.message && error.stack === original.stack);
  const status = await requestRuntime(root, 'status');
  assert.equal(status.health.plugins[0].recovering, true);
  assert.equal(status.health.plugins[0].issueCount, 0);
});
