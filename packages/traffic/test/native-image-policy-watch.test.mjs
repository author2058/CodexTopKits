import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativePolicyWatcher } from '../src/native-image-policy-watch.mjs';
import { RecoveryHealth } from '../../core/src/recovery.mjs';

const passed = () => ({ ok: true, cached: false, version: 'fixture', policyId: 'fixture-policy', failures: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('repeated failed policy checks preserve the first failure deadline and clear only after a real pass', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const original = new Error('Persistent native policy failure'); let passing = false;
  const recovery = new RecoveryHealth(() => {}, () => {});
  const watcher = createNativePolicyWatcher({ check: async () => { if (!passing) throw original; return passed(); }, log: async () => {},
    changed: value => recovery.update({ ok: !value.error, message: value.error?.message || 'Ready.', issueCount: value.error ? 1 : 0 }) });
  t.after(async () => { recovery.close(); await watcher.close(); });
  recovery.start(() => watcher.check());
  await assert.rejects(watcher.check(), error => error === original);
  for (let i = 0; i < 12; i++) { t.mock.timers.tick(5000); await tick(); }
  assert.equal(recovery.health().ok, false); assert.equal(recovery.health().message, original.message);
  passing = true; t.mock.timers.tick(5000); await tick();
  assert.equal(recovery.health().ok, true); assert.equal(watcher.snapshot().error, null);
});

test('version events are nonblocking, deduplicated and share the manual check owner', async () => {
  const calls = [], records = [];
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  const watcher = createNativePolicyWatcher({ check: async ({ force }) => {
    calls.push(force); entered(); if (calls.length === 1) await gate; return passed();
  }, log: async entry => records.push(entry), changed: () => {} });
  assert.equal(watcher.observe('v1'), undefined);
  await began;
  watcher.observe('v1');
  assert.deepEqual(calls, [false]);
  assert.equal(watcher.snapshot().running, true);
  release(); await tick();
  await watcher.check();
  watcher.observe('v2'); await tick();
  assert.deepEqual(calls, [false, true, false]);
  assert.equal(records.length, 3);
  await watcher.close();
});

test('normal forwarding cannot clear a failed check; an explicit successful recheck can', async t => {
  t.mock.method(console, 'error', () => {});
  const original = new Error('exact native failure');
  const records = [];
  let fail = true;
  const watcher = createNativePolicyWatcher({ check: async () => { if (fail) throw original; return passed(); },
    log: async entry => records.push(entry), changed: () => {} });
  watcher.observe('v1'); await tick();
  assert.equal(watcher.snapshot().error, original);
  watcher.observe('v1');
  assert.equal(watcher.snapshot().error, original);
  assert.equal(records[0].stack, original.stack);
  await assert.rejects(watcher.check(), error => error === original);
  fail = false; await watcher.check();
  assert.equal(watcher.snapshot().error, null);
  await watcher.close();
});

test('a changed policy invalidates the old report and checks the same native version again', async () => {
  let calls = 0; const watcher = createNativePolicyWatcher({ check: async () => { calls++; return passed(); }, log: async () => {}, changed: () => {} });
  watcher.observe('v1'); await watcher.idle(); assert.equal(watcher.snapshot().report.policyId, 'fixture-policy');
  await watcher.swap(() => {}); assert.equal(watcher.snapshot().report, null); watcher.observe('v1'); await watcher.idle(); assert.equal(calls, 2); await watcher.close();
});

test('policy swaps serialize with checks already running or newly requested', async () => {
  let policy = 'old', release, entered; const calls = [];
  const began = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const watcher = createNativePolicyWatcher({ check: async () => { const current = policy; calls.push(current); if (current === 'old') { entered(); await gate; } return { ...passed(), policyId: current }; }, log: async () => {}, changed: () => {} });
  watcher.observe('v1'); await began; const swap = watcher.swap(() => { policy = 'new'; }); watcher.observe('v2'); release(); await swap; await watcher.idle();
  assert.deepEqual(calls, ['old', 'new']); assert.equal(watcher.snapshot().report.policyId, 'new'); await watcher.close();
});

test('an in-progress or failed policy installation cannot expose the old report as current', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), failure = new Error('install failed');
  const watcher = createNativePolicyWatcher({ check: async () => passed(), log: async () => {}, changed: () => {} });
  await watcher.check(); const swap = watcher.swap(async () => { await gate; throw failure; }); await tick();
  assert.equal(watcher.snapshot().running, true); assert.equal(watcher.snapshot().report, null); release();
  await assert.rejects(swap, error => error === failure); assert.equal(watcher.snapshot().error, failure); await watcher.close();
});

test('missing version metadata remains a visible gap even after a manual policy pass', async () => {
  const watcher = createNativePolicyWatcher({ check: async () => passed(), log: async () => {}, changed: () => {} });
  watcher.observe(null);
  assert.match(watcher.snapshot().error.message, /metadata is missing/);
  await watcher.check();
  assert.match(watcher.snapshot().error.message, /metadata is missing/);
  watcher.observe('v1'); await tick();
  assert.equal(watcher.snapshot().error, null);
  await watcher.close();
});

test('shutdown cancels only the owned check and prevents later version work', async () => {
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const watcher = createNativePolicyWatcher({ check: async ({ signal }) => {
    entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, log: async () => {}, changed: () => {} });
  watcher.observe('v1'); await began;
  await watcher.close();
  watcher.observe('v2');
  await assert.rejects(watcher.check(), error => error.name === 'AbortError');
});
