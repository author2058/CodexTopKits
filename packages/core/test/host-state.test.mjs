import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPluginHost } from '../src/index.mjs';

test('host state publishes actual health changes and the shared management URL, not repeated identical checks', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-host-state-'));
  const values = []; let context;
  const host = await createPluginHost({ stateDirectory, plugins: [{ id: 'observer', coreApiVersion: 1, async start(value) {
    context = value; value.onHostState(state => values.push(state)); return { close() {} };
  } }] });
  t.after(async () => { await host.close(); await fs.rm(stateDirectory, { recursive: true }); });
  host.setManagementUrl('http://127.0.0.1:12345/fixture/');
  assert.equal(values.at(-1).managerUrl, 'http://127.0.0.1:12345/fixture/');
  context.setHealth({ ok: false, message: 'Two interfaces changed.', issueCount: 2 });
  assert.equal(values.at(-1).health.plugins[0].issueCount, 0);
  assert.equal(values.at(-1).health.plugins[0].recovering, true);
  const before = values.length;
  context.setHealth({ ok: false, message: 'Two interfaces changed.', issueCount: 2 });
  assert.equal(values.length, before);
  assert.throws(() => context.setHealth({ ok: true, message: 'Ready.', issueCount: 2 }), /issue count/);
  await host.close();
  host.setManagementUrl('http://127.0.0.1:12345/after-close/');
  assert.equal(values.length, before);
});

test('a subscriber failure preserves its original error and startup releases all subscriptions', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-host-state-error-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true }));
  const error = new TypeError('host listener failed'); let calls = 0, context;
  await assert.rejects(createPluginHost({ stateDirectory, plugins: [{ id: 'broken', coreApiVersion: 1, async start(value) {
    context = value; value.onHostState(() => { calls++; throw error; });
  } }] }), value => value === error);
  context.setHealth({ ok: true, message: 'No old listener.' });
  assert.equal(calls, 1);
});

test('a notification failure never erases the original plugin check error', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-host-check-error-'));
  const primary = new Error('check failed'), secondary = new TypeError('notification failed');
  const host = await createPluginHost({ stateDirectory, plugins: [{ id: 'checked', coreApiVersion: 1, async start(context) {
    context.onHostState(value => { if (value.health.plugins[0].recovering) throw secondary; });
    return { check() { throw primary; }, close() {} };
  } }] });
  t.after(async () => { await host.close(); await fs.rm(stateDirectory, { recursive: true }); });
  await assert.rejects(host.check(), error => error.cause === primary && error.errors[0] === primary && error.errors[1] === secondary);
});
