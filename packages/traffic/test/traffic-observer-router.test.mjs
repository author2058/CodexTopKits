import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrafficObserverRouter } from '../src/traffic-observer-router.mjs';

test('traffic observations queue while one SQLite owner is exchanged for another', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), calls = [], changed = [];
  const oldFactory = async () => ({ record: value => calls.push(['old', value]), log: { coverage: (...args) => calls.push(['old-coverage', ...args]) }, captureState: () => ({ requested: true, paused: true }), close: () => gate });
  const nextFactory = async options => { calls.push(['opened', options.initialCapture]); return { record: value => calls.push(['new', value]), log: { coverage: (...args) => calls.push(['new-coverage', ...args]) }, captureState: () => ({}), query: () => 'new-query', check() {}, close() {} }; };
  const router = await createTrafficObserverRouter(oldFactory, { changed: value => changed.push(value) }); router.record({ event: 'model-traffic', label: 'before' });
  const update = router.replace(nextFactory); router.record({ event: 'model-traffic', label: 'during' }); router.coverage('coverage', 'info', 'during'); const query = router.query({});
  assert.deepEqual(calls, [['old', { event: 'model-traffic', label: 'before' }]]); release(); await update; assert.equal(await query, 'new-query');
  assert.deepEqual(calls.find(row => row[0] === 'opened')[1], { requested: true, paused: true });
  assert.ok(calls.some(row => row[0] === 'new' && row[1].label === 'during')); assert.ok(calls.some(row => row[0] === 'new-coverage' && row[1] === 'coverage')); assert.ok(calls.some(row => row[1] === 'observer-handoff' && row[2] === 'gap'));
  await router.close();
});

test('a failed candidate reports the error, restores the previous owner and replays buffered records', async () => {
  let release, opens = 0; const gate = new Promise(resolve => { release = resolve; }), calls = [], failure = new Error('candidate failed');
  const factory = async () => { const id = ++opens; return { record: value => calls.push([id, value]), log: { coverage() {} }, captureState: () => ({ requested: false, paused: false }), close: () => id === 1 ? gate : undefined }; };
  const router = await createTrafficObserverRouter(factory, { changed() {} }); const update = router.replace(async () => { throw failure; }); router.record({ event: 'model-traffic', label: 'during' }); release();
  await assert.rejects(update, error => error === failure); assert.equal(opens, 2); assert.deepEqual(calls, [[2, { event: 'model-traffic', label: 'during' }]]); await router.close();
});

test('disabling the observer leaves other bandwidth operations independent', async () => {
  let cleared = false; const factory = async () => ({ record() {}, log: { coverage() {} }, captureState: () => ({}), close() {} });
  const router = await createTrafficObserverRouter(factory, { changed: value => { cleared = value.length === 0; } }); await router.replace(null);
  assert.equal(router.active(), false); assert.equal(cleared, true); router.record('ignored'); await router.check(); await assert.rejects(router.query({}), /未启用/); await router.close();
});

test('if closing the old collector fails, later metadata remains queued until a successful retry', async () => {
  const failure = new Error('collector close failed'), recorded = [];
  const original = async () => ({ record() {}, log: { coverage() {} }, captureState: () => ({ requested: false, paused: false }), close() { throw failure; } });
  const router = await createTrafficObserverRouter(original, { changed() {} }); await assert.rejects(router.replace(original), error => error === failure);
  router.record({ event: 'model-traffic', label: 'after failure' }); const next = async () => ({ record: value => recorded.push(value), log: { coverage() {} }, captureState: () => ({}), close() {} });
  await router.replace(next); assert.deepEqual(recorded, [{ event: 'model-traffic', label: 'after failure' }]); await router.close();
});

test('an in-progress capture toggle finishes before its state is handed to the new collector', async () => {
  let release, paused = false, received;
  const original = async () => ({ record() {}, log: { coverage() {} }, captureState: () => ({ requested: true, paused }), close() {},
    async setCapture(enabled) { await new Promise(resolve => { release = resolve; }); paused = !enabled; return { enabled }; } });
  const next = async options => { received = options.initialCapture; return { record() {}, log: { coverage() {} }, captureState: () => received, close() {} }; };
  const router = await createTrafficObserverRouter(original, { changed() {} }); const toggle = router.setCapture(false), update = router.replace(next);
  assert.equal(received, undefined); release(); await toggle; await update; assert.deepEqual(received, { requested: true, paused: true }); await router.close();
});
