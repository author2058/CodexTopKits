import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryHealth } from '../src/recovery.mjs';
import { createPluginHost } from '../src/index.mjs';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const failure = { ok: false, message: 'Original connection failure', issueCount: 2 };

test('per-issue identity survives known retries and pending recovery; unknown failures remain separate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const recovery = new RecoveryHealth(() => {}, () => {}); t.after(() => recovery.close());
  const issues = [{ key: 'first', message: 'First failure' }, { key: 'second', message: 'Second failure' }];
  recovery.update({ ok: false, issueCount: 2, message: 'First failure; Second failure', issues });
  assert.deepEqual(recovery.health().issues, issues);
  const known = new Error('First failure');
  await assert.rejects(recovery.run(async () => { throw known; }), error => error === known);
  assert.deepEqual(recovery.health().issues, issues); assert.equal(recovery.check.issueCount, 2);
  const unexpected = new TypeError('Unexpected recovery failure');
  await assert.rejects(recovery.run(async () => { throw unexpected; }), error => error === unexpected);
  assert.equal(recovery.check.issueCount, 3);
  assert.deepEqual(recovery.check.issues.at(-1), { key: '@recovery', message: unexpected.message });
  await assert.rejects(recovery.run(async () => { throw unexpected; }), error => error === unexpected);
  assert.equal(recovery.check.issueCount, 3, 'a repeated recovery exception does not append another issue');
  recovery.update({ ok: true, message: 'Ready.', issueCount: 0, issues: [] });
  assert.deepEqual(recovery.health().issues, []);
});

test('recovery is quiet for one minute, keeps retrying afterwards, and clears immediately on success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const states = [], diagnostics = [];
  let attempts = 0, succeeds = false;
  const recovery = new RecoveryHealth(() => states.push(recovery.health()), error => diagnostics.push(error));
  t.after(() => recovery.close());
  recovery.start(async () => { attempts++; if (succeeds) recovery.update({ ok: true, message: 'Connected.', issueCount: 0 }); else recovery.update(failure); });
  recovery.update(failure);
  assert.equal(states.at(-1).recovering, true);
  for (let i = 0; i < 11; i++) { t.mock.timers.tick(5000); await settle(); }
  assert.equal(attempts, 11); assert.equal(recovery.health().ok, true);
  t.mock.timers.tick(4999); await settle(); assert.equal(recovery.health().ok, true);
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(recovery.health(), failure);
  t.mock.timers.tick(5000); await settle(); assert.equal(attempts, 13);
  succeeds = true; t.mock.timers.tick(5000); await settle();
  assert.deepEqual(states.at(-1), { ok: true, message: 'Connected.', issueCount: 0 });
  const completed = attempts; t.mock.timers.tick(120000); await settle();
  assert.equal(attempts, completed, 'healthy components have no retry timer');
  assert.deepEqual(diagnostics, []);
  recovery.update(failure); assert.equal(recovery.health().recovering, true, 'a later failure gets its own grace period');
});

test('explicit Kit failures are immediately visible, never auto-retried, and clear on a healthy report', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-recovery-kit-'));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let context, attempts = 0;
  const host = await createPluginHost({ stateDirectory: directory, plugins: [{ id: 'features', coreApiVersion: 1, async start(value) {
    context = value; context.setHealth({ ok: true, message: 'Ready.' });
    return { check() { attempts++; context.setHealth({ ok: true, message: 'Recovered.' }); }, close() {} };
  } }] });
  t.after(async () => { await host.close(); await fs.rm(directory, { recursive: true }); });
  assert.throws(() => context.setHealth({ ok: false, message: 'Invalid flag.', recoverable: 'false' }), /Invalid plugin recoverability/);
  assert.throws(() => context.setHealth({ ok: false, message: 'Invalid issues.', issues: [{ key: 'fixture' }] }), /Invalid plugin issues/);
  context.setHealth({ ok: false, message: 'Native Kit route changed.', issueCount: 1, recoverable: false });
  assert.equal(host.health().ok, false); assert.equal(host.health().plugins[0].issueCount, 1);
  t.mock.timers.tick(65000); await settle(); assert.equal(attempts, 0); assert.equal(host.health().ok, false);
  await host.check(); assert.equal(attempts, 1); assert.equal(host.health().ok, true);
  context.setHealth({ ok: false, message: 'Another Kit error.', issueCount: 1, recoverable: false });
  context.setHealth({ ok: true, message: 'Native event recovered.' });
  assert.equal(host.health().ok, true); assert.equal(host.health().plugins[0].issueCount, 0);
  context.setHealth(failure); assert.equal(host.health().plugins[0].recovering, true, 'transport-style failures keep their existing grace');
});

test('a failed explicit recheck preserves an unrecoverable failure and the original exception', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const errors = [], original = new TypeError('Native contract is still incompatible.');
  const recovery = new RecoveryHealth(() => {}, error => errors.push(error)); t.after(() => recovery.close());
  recovery.update({ ok: false, message: 'Native contract changed.', issueCount: 1, recoverable: false });
  await assert.rejects(recovery.run(async () => { throw original; }, true), error => error === original);
  assert.equal(errors[0], original); assert.equal(recovery.health().ok, false);
  assert.equal(recovery.health().recoverable, false); assert.equal(recovery.health().message, original.message);
});

test('only one recovery runs per component; an attempt that fails after an intermediate healthy report still retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const original = new TypeError('Exact original diagnostic'), pending = Promise.withResolvers(), errors = [];
  const recovery = new RecoveryHealth(() => {}, error => errors.push(error));
  t.after(() => recovery.close());
  let attempts = 0;
  recovery.start(async () => { attempts++; await pending.promise; }); recovery.update(failure);
  const work = recovery.run(); assert.equal(work, recovery.run()); await settle();
  t.mock.timers.tick(70000); await settle(); assert.equal(attempts, 1);
  recovery.update({ ok: true, message: 'Connection is open; initialization still pending.', issueCount: 0 });
  pending.reject(original); await assert.rejects(work, error => error === original);
  assert.equal(recovery.health().ok, false, 'intermediate progress cannot reset the expired first-failure deadline'); assert.equal(errors[0], original);
  t.mock.timers.tick(5000); await settle(); assert.equal(attempts, 2);
  recovery.update({ ok: true, message: 'Recovered.', issueCount: 0 });
  assert.equal(recovery.health().ok, true);
  recovery.update(failure); recovery.close(); t.mock.timers.tick(120000); await settle(); assert.equal(attempts, 2);
});

test('a manual host check joins an active automatic attempt instead of running the component twice', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-recovery-manual-'));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const gate = Promise.withResolvers(); let checks = 0, context;
  const host = await createPluginHost({ stateDirectory: directory, plugins: [{ id: 'sample', coreApiVersion: 1, async start(value) {
    context = value;
    return { async check() { checks++; await gate.promise; context.setHealth({ ok: true, message: 'Recovered.' }); }, close() {} };
  } }] });
  t.after(async () => { gate.resolve(); await host.close(); await fs.rm(directory, { recursive: true }); });
  context.setHealth(failure); t.mock.timers.tick(5000); await settle();
  const manual = host.check(); await settle(); assert.equal(checks, 1);
  gate.resolve(); assert.equal((await manual).ok, true); assert.equal(checks, 1);
});

test('the host retries failed components independently and publishes successful recovery synchronously', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-recovery-'));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const contexts = [], attempts = [0, 0];
  const host = await createPluginHost({ stateDirectory: directory, plugins: ['one', 'two'].map((id, index) => ({
    id, coreApiVersion: 1, async start(context) {
      contexts[index] = context;
      context.setHealth({ ok: true, message: 'Ready.' });
      return { check() { attempts[index]++; context.setHealth(index ? failure : { ok: true, message: 'Recovered.' }); }, close() {} };
    },
  })) });
  t.after(async () => { await host.close(); await fs.rm(directory, { recursive: true }); });
  for (const context of contexts) context.setHealth(failure);
  for (let i = 0; i < 12; i++) { t.mock.timers.tick(5000); await settle(); }
  assert.deepEqual(attempts, [1, 12]);
  assert.equal(host.health().plugins[0].ok, true); assert.equal(host.health().plugins[1].ok, false);
  contexts[1].setHealth({ ok: true, message: 'Recovered from native event.' });
  assert.equal(host.health().ok, true);
  await host.close(); t.mock.timers.tick(120000); await settle(); assert.deepEqual(attempts, [1, 12]);
});

test('host shutdown stops retries before releasing the component that cancels its in-flight recovery', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-recovery-close-'));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const gate = Promise.withResolvers(); let context, closed = false, attempts = 0;
  const host = await createPluginHost({ stateDirectory: directory, plugins: [{ id: 'sample', coreApiVersion: 1, async start(value) {
    context = value;
    return { async check() { attempts++; await gate.promise; }, close() { closed = true; gate.resolve(); } };
  } }] });
  t.after(async () => { gate.resolve(); await host.close(); await fs.rm(directory, { recursive: true }); });
  context.setHealth(failure); t.mock.timers.tick(5000); await settle();
  const stopping = host.close(); await settle(); assert.equal(closed, true); await stopping;
  t.mock.timers.tick(120000); await settle(); assert.equal(attempts, 1);
});
