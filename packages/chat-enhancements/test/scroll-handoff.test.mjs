import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollHandoffCorrection, installScrollHandoffRepair } from '../src/scroll-handoff.mjs';

// Real 2026-10-22 incident: cached 222px replaced a measured 862px row.
function incident() {
  const entries = [{ turnKey: 'old:previous', turnId: 'previous' }, { turnKey: 'old:current', turnId: 'current' }];
  const next = entries.map(entry => ({ ...entry, turnKey: entry.turnKey.replace('old:', 'new:') }));
  const layout = (keys, heights) => ({ turnKeys: keys.map(entry => entry.turnKey), heightsPx: heights,
    bottomOffsetsPx: [heights[1] + 12, 0], totalHeightPx: heights[0] + 12 + heights[1] });
  return { entries, next, old: layout(entries, [1018, 862]), stale: layout(next, [1018, 222]), measured: layout(next, [1018, 862]) };
}

const baseline = f => ({ entries: f.entries, layout: f.old, distance: 132, padding: 0, viewportHeight: 584 });

test('real stale-identity compensation is removed without forcing the reader to the bottom', () => {
  const f = incident(), result = scrollHandoffCorrection(baseline(f), f.next, [f.measured, f.old, f.stale], 132, 772, 0);
  assert.equal(result.distance, 132); assert.equal(result.requested - result.distance, 640);
  assert.equal(result.anchor.turnId, 'current');
});

test('missing or ambiguous reading anchors remain native with an explicit reason', () => {
  const f = incident(), before = baseline(f), layouts = [f.measured, f.stale];
  assert.equal(scrollHandoffCorrection(before, [...f.next, { turnId: 'another', turnKey: 'another' }], layouts, 132, 772, 0).reason, 'native-submit-placement');
  assert.equal(scrollHandoffCorrection(before, f.next.map(e => ({ ...e, turnId: 'different' })), layouts, 132, 772, 0).reason, 'native-submit-placement');
  assert.equal(scrollHandoffCorrection(before, f.entries, [f.old], 132, 772, 0).reason, 'keys-unchanged');
  assert.equal(scrollHandoffCorrection(before, f.next, [f.old], 132, 772, 0).reason, 'current-layout-missing');
  const repeated = f.entries.map(e => ({ ...e, turnId: 'same' }));
  assert.equal(scrollHandoffCorrection({ ...before, entries: repeated }, f.next.map(e => ({ ...e, turnId: 'same' })), layouts, 132, 772, 0).reason, 'repeated-transcript-turn');
});

test('real growth is preserved independently from the wrong key-cache compensation', () => {
  const f = incident(), before = baseline(f);
  const growing = { ...f.measured, heightsPx: [1018, 900] };
  assert.equal(scrollHandoffCorrection(before, f.next, [growing], 132, 810, 0).distance, 170);
  assert.equal(scrollHandoffCorrection({ ...before, followBottom: true }, f.next, [growing], 0, 810, 0).distance, 0);
});

test('composer/footer height is distinct from list height, including a viewport ending below the last row', () => {
  const f = incident(), before = { ...baseline(f), bottomInset: 190, distance: 10 };
  const result = scrollHandoffCorrection(before, f.next, [f.measured], 10, 650, 0, 210);
  assert.equal(result.anchor.turnId, 'current'); assert.equal(result.distance, 30);
  assert.equal(result.baselineInset, 190); assert.equal(result.bottomInset, 210);
});

function fixture(f = incident()) {
  const errors = [], records = [], calls = [], subscriptions = new Set(), listeners = new Map(), frames = new Map();
  let frameId = 0;
  const viewport = f.viewportHeight ?? 584, topInset = f.topInset ?? 0;
  let inset = f.bottomInset ?? 0;
  let top = f.old.totalHeightPx + inset + topInset - viewport - (f.distance ?? 132), distance = f.distance ?? 132;
  const result = {}, nativeError = new TypeError('native scroll error');
  const proto = { scrollTo(options) { calls.push({ receiver: this, options }); if (options.fail) throw nativeError; top = options.top; return result; } };
  const element = Object.assign(Object.create(proto), { scrollHeight: f.old.totalHeightPx + inset + topInset, clientHeight: viewport,
    querySelector: () => row, querySelectorAll: () => [row],
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) });
  Object.defineProperty(element, 'scrollTop', { get: () => top });
  const root = { nodeType: 1, getBoundingClientRect: () => ({ bottom: element.scrollHeight - inset, height: element.scrollHeight - inset - topInset }) };
  element.firstElementChild = { getBoundingClientRect: () => ({ bottom: element.scrollHeight, height: element.scrollHeight - topInset }) };
  const hook = { memoizedState: { current: f.old }, next: { memoizedState: { current: root } } };
  const list = { memoizedProps: { entries: f.entries, onLatestTurnHeightChange() {} }, memoizedState: hook,
    return: { memoizedProps: { entries: f.entries, conversationId: 'thread', consumePendingLatestTurnSubmitPlacement() {} } } };
  const row = { __reactFiber$test: { return: list } };
  const api = { getScrollElement: () => element, getLastScrollDistanceFromBottomPx: () => distance,
    getUnroundedScrollDistanceFromBottomPx: value => value,
    addScrollListener(fn) { subscriptions.add(fn); fn(); return () => subscriptions.delete(fn); } };
  element.__reactFiber$test = { memoizedProps: { value: api } };
  const document = { querySelectorAll: () => [element], defaultView: { devicePixelRatio: 1,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); } } };
  function compensateScrollToDistanceFromBottomPx(value) {
    const valueReturned = element.scrollTo({ top: element.scrollHeight - element.clientHeight - value, behavior: 'instant' });
    distance = element.scrollHeight - element.clientHeight - top;
    for (const fn of subscriptions) fn();
    return valueReturned;
  }
  api.compensateScrollToDistanceFromBottomPx = compensateScrollToDistanceFromBottomPx;
  api.scrollToDistanceFromBottomPx = compensateScrollToDistanceFromBottomPx;
  api.scrollToBottom = () => compensateScrollToDistanceFromBottomPx(0);
  return { ...f, errors, records, calls, subscriptions, listeners, frames, element, api, proto, nativeError, result, document, list,
    start(report = record => records.push(record)) { return installScrollHandoffRepair(document, scrollHandoffCorrection, report, (error, info) => errors.push({ error, info })); },
    handoff(entries = f.next, values = [f.measured, f.stale, f.old]) {
      list.memoizedProps = { ...list.memoizedProps, entries };
      list.memoizedState = values.reduceRight((next, value) => ({ memoizedState: { current: value }, next }), { memoizedState: { current: root } });
    },
    clamp: () => { top = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight)); },
    setInset: value => { inset = value; },
    compensateScrollToDistanceFromBottomPx: (...args) => api.compensateScrollToDistanceFromBottomPx(...args),
    notify: () => { for (const fn of subscriptions) fn(); },
    frame: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
  };
}

function rowLayout(rows, totalHeightPx, tail) {
  const heightsPx = Array(rows.length - tail.length).fill(500).concat(tail);
  heightsPx[0] += totalHeightPx - heightsPx.reduce((a, b) => a + b, 0) - (rows.length - 1) * 12;
  const bottomOffsetsPx = Array(rows.length);
  let bottom = 0;
  for (let index = rows.length - 1; index >= 0; index--) { bottomOffsetsPx[index] = bottom; bottom += heightsPx[index] + 12; }
  return { turnKeys: rows.map(row => row.turnKey), heightsPx, bottomOffsetsPx, totalHeightPx };
}

function countChangeIncident() {
  const entries = [...Array.from({ length: 37 }, (_, index) => 'prefix-' + index), 'near-a', 'near-b', 'previous', 'current']
    .map(turnId => ({ turnId, turnKey: 'tail:0:' + turnId }));
  const next = entries.slice(7).map(entry => ({ ...entry, turnKey: entry.turnKey.replace('tail:0:', 'tail:4:') }));
  // Counts, totals and last four heights are from 2026-10-28 16:47. The
  // unrecorded prefix heights only fill each total; they are not a full trace.
  return { entries, next, distance: 611, viewportHeight: 685, bottomInset: 190,
    old: rowLayout(entries, 36791, [695, 1179, 450, 1311]),
    stale: rowLayout(next, 29968, [695, 1245, 450, 144]),
    measured: rowLayout(next, 31167, [695, 1245, 450, 1343]),
    restored: rowLayout(entries, 36823, [695, 1179, 450, 1343]) };
}

test('the 19:17 restored list is repaired without a subsequent native scroll call', () => {
  const next = [...Array.from({ length: 42 }, (_, index) => 'prefix-' + index), 'reading', 'current']
    .map(turnId => ({ turnId, turnKey: 'tail:0:' + turnId }));
  const entries = next.slice(7).map(row => ({ ...row, turnKey: row.turnKey.replace('tail:0:', 'tail:4:') }));
  const old = rowLayout(entries, 34310, [1618, 26]), restored = rowLayout(next, 40084, [1566, 144]);
  const f = fixture({ entries, next, old, measured: restored, distance: 214, viewportHeight: 685, bottomInset: 473, topInset: 32 });
  const repair = f.start();
  assert.equal(f.element.scrollTop, 33916); assert.equal(f.frames.size, 0);
  f.element.scrollHeight = 40589; f.handoff(next, [restored, old]); f.notify();
  assert.equal(f.element.scrollHeight - f.element.clientHeight - f.element.scrollTop, 5988);
  assert.equal(f.frames.size, 1); assert.equal(f.calls.length, 0);
  // The native response spacer disappears before the scheduled layout read.
  f.setInset(158); f.element.scrollHeight = 40274;
  f.frame();
  assert.equal(f.element.scrollHeight - f.element.clientHeight - f.element.scrollTop, 0);
  const result = f.records.find(record => record.kind === 'scroll-handoff-result');
  assert.equal(result.source, 'layout-frame'); assert.equal(result.settled, true); assert.equal(result.actualDistance, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.frames.size, 0);
  for (let index = 0; index < 10; index++) { f.notify(); repair.refresh(); f.frame(); }
  assert.equal(f.calls.length, 1); assert.equal(f.frames.size, 0); assert.deepEqual(f.errors, []);
  repair.cleanup();
});

test('pending-user reconciliation leaves native placement at zero even when the growth-follow flag is false', () => {
  const base = incident(), entries = [...base.entries, { turnKey: 'pending-user-message:optimistic' }];
  const next = [...base.entries, { turnId: 'new-turn', turnKey: 'tail:new-turn' }];
  const old = rowLayout(entries, 1976, [1018, 862, 72]), measured = rowLayout(next, 2048, [1018, 862, 144]);
  const f = fixture({ entries, next, old, measured, distance: 0 });
  f.api.shouldFollowContentGrowth = () => false;
  const repair = f.start(); f.handoff(next, [measured, old]); f.element.scrollHeight = 2048;
  f.compensateScrollToDistanceFromBottomPx(0); f.frame();
  assert.equal(f.element.scrollTop, 2048 - 584); assert.equal(repair.status().corrected, 0);
  assert.ok(f.records.some(record => record.reason === 'native-submit-placement'));
  const changed = next.map(row => ({ ...row, turnKey: 'renamed:' + row.turnKey }));
  f.handoff(changed, [{ ...measured, turnKeys: changed.map(row => row.turnKey) }]);
  f.compensateScrollToDistanceFromBottomPx(144);
  assert.equal(f.element.scrollTop, 2048 - 584); // keep the native bottom intent across cache replacement
  assert.deepEqual(f.errors, []); repair.cleanup();
});

test('manual scrolling and cleanup cancel scheduled layout restoration', () => {
  const f = fixture(), repair = f.start(); f.handoff(); f.notify();
  assert.equal(f.frames.size, 1); f.listeners.get('wheel')(); f.frame();
  assert.equal(f.frames.size, 0); assert.equal(f.calls.length, 0);
  repair.refresh(); f.handoff(f.entries, [f.old]); f.notify();
  assert.equal(f.frames.size, 1); repair.cleanup(); f.frame();
  assert.equal(f.frames.size, 0); assert.equal(f.calls.length, 0);
});

test('native compensation errors retain their identity; frame-driven errors disable the guard and restore the API', () => {
  const f = fixture(), native = f.api.compensateScrollToDistanceFromBottomPx, repair = f.start();
  f.handoff(); f.proto.scrollTo = () => { throw f.nativeError; };
  assert.throws(() => f.compensateScrollToDistanceFromBottomPx(772), error => error === f.nativeError);
  f.element.scrollHeight += 640; f.notify(); f.frame();
  assert.equal(repair.status().enabled, false); assert.equal(f.errors[0].error, f.nativeError);
  assert.equal(f.api.compensateScrollToDistanceFromBottomPx, native);
  assert.equal(f.frames.size, 0); assert.equal(f.subscriptions.size, 0);
});

test('the real 41 -> 34 -> 41 replacement keeps the unique reading anchor and never adopts the wrong distance', () => {
  const f = fixture(countChangeIncident()), repair = f.start();
  f.element.scrollHeight = 30158; f.handoff(f.next, [f.stale, f.old]); f.clamp();
  assert.equal(f.element.scrollTop, 29473);
  f.notify(); repair.refresh(); f.notify();
  f.element.scrollHeight = 31357; f.handoff(f.next, [f.measured, f.stale, f.old]);
  f.notify(); f.compensateScrollToDistanceFromBottomPx(1810);
  assert.equal(f.element.scrollTop, 31357 - 685 - 643);
  const first = f.records.find(record => record.kind === 'scroll-handoff-corrected');
  assert.equal(first.baselineDistance, 611); assert.equal(first.distance, 643);
  assert.equal(first.previousCount, 41); assert.equal(first.currentCount, 34);
  assert.equal(first.anchor.previousIndex, 40); assert.equal(first.anchor.index, 33);
  f.element.scrollHeight = 37013; f.handoff(f.entries, [f.restored, f.measured, f.old]);
  f.notify(); repair.refresh();
  f.compensateScrollToDistanceFromBottomPx(675); // corrected 643 + the returning cache's stale 32px
  assert.equal(f.element.scrollTop, 37013 - 685 - 643);
  assert.equal(repair.status().corrected, 2);
  const last = f.records.filter(record => record.kind === 'scroll-handoff-corrected').at(-1);
  assert.equal(last.baselineDistance, 643); assert.equal(last.distance, 643);
  assert.equal(last.anchor.previousIndex, 33); assert.equal(last.anchor.index, 40);
  assert.ok(!f.records.some(record => record.reason === 'reading-baseline-rebased'));
  assert.deepEqual(f.errors, []); repair.cleanup();
});

test('repeated IDs outside the visible anchor do not prevent its unique match', () => {
  const f = countChangeIncident();
  f.entries[0].turnId = f.entries[1].turnId = 'unrelated-transcript';
  const result = scrollHandoffCorrection({ ...baseline(f), distance: 611, bottomInset: 190, viewportHeight: 685 }, f.next, [f.measured], 611, 1810, 0, 190);
  assert.equal(result.anchor.turnId, 'current'); assert.equal(result.distance, 643);
});

test('appending a new turn without replacing the reading row keeps native submit placement', () => {
  const f = fixture(), repair = f.start();
  const entries = [...f.entries, { turnId: 'new-turn', turnKey: 'new-turn' }];
  f.handoff(entries, [{ turnKeys: entries.map(entry => entry.turnKey), heightsPx: [1018, 862, 400],
    bottomOffsetsPx: [1286, 412, 0], totalHeightPx: 2304 }]);
  f.element.scrollHeight = 2304; f.compensateScrollToDistanceFromBottomPx(0);
  assert.equal(repair.status().corrected, 0);
  assert.equal(f.element.scrollTop, 2304 - 584);
  assert.ok(f.records.some(record => record.reason === 'new-rows-appended'));
  assert.deepEqual(f.errors, []); repair.cleanup();
});

test('a temporarily missing current layout retains the original anchor until measurement arrives', () => {
  const f = fixture(), repair = f.start();
  f.handoff(f.next, [f.old]); f.notify(); f.compensateScrollToDistanceFromBottomPx(772);
  assert.equal(repair.status().corrected, 0);
  assert.ok(f.records.some(record => record.reason === 'current-layout-missing'));
  assert.ok(!f.records.some(record => record.reason === 'reading-baseline-rebased'));
  f.handoff(); f.compensateScrollToDistanceFromBottomPx(772);
  assert.equal(f.records.filter(record => record.kind === 'scroll-handoff-corrected').at(-1).baselineDistance, 132);
  assert.equal(repair.status().corrected, 1); repair.cleanup();
});

test('native distance subscription repairs the captured handoff without timers or scrolling on installation', () => {
  const f = fixture(), repair = f.start();
  assert.equal(f.calls.length, 0); assert.equal(f.subscriptions.size, 1);
  f.handoff();
  assert.equal(f.compensateScrollToDistanceFromBottomPx(772), f.result);
  assert.equal(f.element.scrollTop, f.element.scrollHeight - f.element.clientHeight - 132);
  assert.equal(repair.status().corrected, 1);
  assert.equal(f.records[0].requested - f.records[0].distance, 640);
  assert.deepEqual(f.errors, []);
  repair.cleanup(); assert.equal(f.subscriptions.size, 0); assert.equal(f.element.scrollTo, f.proto.scrollTo);
});

test('explicit navigation and native argument/return/exception identity are retained', () => {
  const f = fixture(), repair = f.start(); f.handoff();
  f.notify(); assert.equal(f.frames.size, 1);
  assert.equal(f.api.scrollToDistanceFromBottomPx(400), f.result);
  assert.equal(f.frames.size, 0);
  const options = { top: 7208, behavior: 'instant', left: 12 };
  assert.equal(f.element.scrollTo(options), f.result);
  assert.equal(f.calls.at(-1).options, options); assert.equal(f.calls.at(-1).receiver, f.element);
  assert.equal(f.element.scrollTop, 7208); assert.equal(repair.status().corrected, 0);
  assert.throws(() => f.element.scrollTo({ fail: true }), error => error === f.nativeError);
  repair.cleanup();
});

test('diagnostic failure leaves native operation intact and preserves the real failure', () => {
  const f = fixture(), failure = new TypeError('log sink failed'), repair = f.start(() => { throw failure; });
  f.handoff(); f.compensateScrollToDistanceFromBottomPx(772);
  assert.equal(f.element.scrollTop, f.element.scrollHeight - f.element.clientHeight - 772);
  assert.equal(repair.status().enabled, false);
  assert.equal(f.errors[0].error, failure); assert.equal(f.errors[0].info.stack, failure.stack);
});

test('repeated refreshes do not multiply subscriptions and cleanup retains a later wrapper', () => {
  const f = fixture(), repair = f.start();
  for (let i = 0; i < 10; i++) repair.refresh();
  assert.equal(f.subscriptions.size, 1); assert.equal(f.calls.length, 0);
  const later = () => 'later'; f.api.compensateScrollToDistanceFromBottomPx = later; repair.cleanup();
  assert.equal(f.api.compensateScrollToDistanceFromBottomPx, later); assert.equal(f.subscriptions.size, 0);
  assert.equal(f.listeners.size, 0);
});

test('a post-clamp native notification cannot replace the pre-handoff reading baseline', () => {
  const f = fixture(), repair = f.start();
  f.handoff();
  f.notify(); repair.refresh(); f.notify();
  f.compensateScrollToDistanceFromBottomPx(772);
  assert.equal(repair.status().corrected, 1);
  const record = f.records.find(record => record.kind === 'scroll-handoff-corrected');
  assert.equal(record.baselineDistance, 132);
  assert.equal(record.distance, 132);
  assert.equal(f.records.filter(record => record.kind === 'scroll-handoff-transition').length, 1);
  repair.cleanup();
});

test('the 2026-10-28 collapse/remeasure/restore preserves the same visible row, not the clamped bottom', () => {
  // Prefix heights are derived from the recorded totals; the last two row
  // heights, viewport, distances and native requested 1339 are captured values.
  const entries = ['prefix', 'previous', 'current'].map(turnId => ({ turnId, turnKey: 'tail:0:' + turnId }));
  const layout = (keys, heights) => ({ turnKeys: keys.map(e => e.turnKey), heightsPx: heights,
    bottomOffsetsPx: [heights[1] + heights[2] + 24, heights[2] + 12, 0], totalHeightPx: heights.reduce((a, b) => a + b, 24) });
  const old = layout(entries, [28187, 1489, 895]);
  const next = entries.map(e => ({ ...e, turnKey: e.turnKey.replace('tail:0:', 'tail:4:') }));
  const measured = layout(next, [22257, 1541, 979]);
  assert.equal(old.totalHeightPx, 30595); assert.equal(measured.totalHeightPx, 24801);
  const result = scrollHandoffCorrection({ entries, layout: old, distance: 386, padding: 0, viewportHeight: 685 }, next, [measured], 386, 1339, 0);
  assert.equal(result.anchor.turnId, 'previous'); assert.equal(result.distance, 522);
  const nextTop = measured.totalHeightPx - 685 - result.distance;
  assert.equal(nextTop - (measured.totalHeightPx - result.anchor.belowAfter), (old.totalHeightPx - 685 - 386) - (old.totalHeightPx - result.anchor.belowBefore));
  const restored = layout(entries, [28187, 1489, 927]);
  const back = scrollHandoffCorrection({ entries: next, layout: measured, distance: 522, padding: 0, viewportHeight: 685 }, entries, [restored], 522, 1371, 0);
  assert.equal(back.distance, 418); // only the genuine final 32px growth remains
});

test('manual scrolling cancels an unfinished handoff instead of pulling the reader back', () => {
  const f = fixture(), repair = f.start(); f.handoff();
  f.listeners.get('wheel')();
  f.compensateScrollToDistanceFromBottomPx(772);
  assert.equal(repair.status().corrected, 0);
  assert.equal(f.element.scrollTop, f.element.scrollHeight - f.element.clientHeight - 772);
  repair.cleanup();
});

test('a different latest turn is diagnosed as native submit placement, not an old reading anchor', () => {
  const f = fixture(), repair = f.start();
  f.handoff(f.next.map(entry => ({ ...entry, turnId: 'different-' + entry.turnId })), [f.measured]);
  f.notify();
  assert.equal(f.records[0].reason, 'reading-baseline-rebased');
  assert.equal(f.records[0].matchReason, 'native-submit-placement');
  assert.equal(f.records[0].previousCount, 2); assert.equal(f.records[0].currentCount, 2);
  assert.equal(f.calls.length, 0); repair.cleanup();
});

test('retained rows before the virtualized list do not permanently disable protection', () => {
  const f = fixture(), retained = { __reactFiber$test: { memoizedProps: {} } }, row = f.element.querySelector();
  f.element.querySelector = () => retained;
  f.element.querySelectorAll = () => [retained, row];
  const repair = f.start();
  assert.equal(repair.status().enabled, true); assert.equal(f.subscriptions.size, 1);
  f.handoff(); f.compensateScrollToDistanceFromBottomPx(772);
  assert.equal(repair.status().corrected, 1); assert.deepEqual(f.errors, []);
  repair.cleanup();
});

test('a hidden detached viewport is not an interface failure; a visible missing controller still is', () => {
  const f = fixture(), original = f.api.getScrollElement;
  f.element.clientHeight = 0; f.api.getScrollElement = () => null;
  const repair = f.start();
  assert.equal(repair.status().enabled, true); assert.equal(repair.status().surfaces, 0);
  assert.equal(repair.status().retainedWithoutController, 1);
  assert.equal(f.records[0].reason, 'retained-viewport-without-native-owner');
  f.element.clientHeight = 584; f.api.getScrollElement = original; repair.refresh();
  assert.equal(repair.status().surfaces, 1); assert.equal(f.subscriptions.size, 1); repair.cleanup();
  const bad = fixture(); bad.api.getScrollElement = () => null;
  const failed = bad.start();
  assert.equal(failed.status().enabled, false);
  assert.match(bad.errors[0].error.message, /layout interface changed/);
});

test('a geometry error during initial subscription restores the methods and removes the subscription', () => {
  const f = fixture(), failure = new TypeError('native geometry failure');
  f.element.firstElementChild.getBoundingClientRect = () => { throw failure; };
  const repair = f.start();
  assert.equal(repair.status().enabled, false); assert.equal(repair.status().surfaces, 0);
  assert.equal(f.errors[0].error, failure); assert.equal(f.element.scrollTo, f.proto.scrollTo);
  assert.equal(f.subscriptions.size, 0); assert.equal(f.listeners.size, 0);
});

test('serialized functions need no module globals; native interface drift is visible', () => {
  const f = fixture(), installer = (0, eval)('(' + installScrollHandoffRepair.toString() + ')');
  const calculate = (0, eval)('(' + scrollHandoffCorrection.toString() + ')');
  const repair = installer(f.document, calculate, record => f.records.push(record), error => f.errors.push(error));
  f.handoff(); f.compensateScrollToDistanceFromBottomPx(772); assert.equal(repair.status().corrected, 1); repair.cleanup();
  const other = fixture(); delete other.api.addScrollListener;
  const failed = other.start(); assert.equal(failed.status().enabled, false); assert.match(other.errors[0].error.message, /subscription changed/);
});
