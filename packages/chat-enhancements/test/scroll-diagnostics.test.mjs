import test from 'node:test';
import assert from 'node:assert/strict';
import { installScrollDiagnostics } from '../src/scroll-diagnostics.mjs';

function fixture() {
  const records = [], errors = [], calls = [], microtasks = [], frames = new Map(), listeners = new Map();
  let clock = 0, nextFrame = 0, notify, top = 500;
  const result = {}, nativeError = new Error('native scroll failure');
  const proto = {
    scrollTo(...args) { calls.push({ receiver: this, args }); if (args[0]?.fail) throw nativeError; top = args[0].top; return result; },
    scrollBy(options) { top += options.top; return result; },
  };
  Object.defineProperty(proto, 'scrollTop', { configurable: true, get() { return top; }, set(value) { top = value; } });
  const element = Object.assign(Object.create(proto), {
    scrollHeight: 1600, clientHeight: 600,
    querySelector: () => row, querySelectorAll: () => [row],
    addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key),
  });
  const ref = { current: { followMode: 'user_follow' } }, key = { current: 'tail:current' }, phase = { current: 'final_answer' };
  const entries = [{ turnKey: 'turn:previous', turnId: 'previous', turnStatus: 'completed', text: 'private previous answer' },
    { turnKey: key.current, turnId: 'current', turnStatus: 'inProgress', text: 'private current answer' }];
  const follow = { memoizedProps: { entries, conversationId: 'thread', consumePendingLatestTurnSubmitPlacement() {} },
    memoizedState: { memoizedState: ref, next: { memoizedState: key, next: { memoizedState: phase } } } };
  const list = { memoizedProps: { entries, onLatestTurnHeightChange() {} }, return: follow };
  const row = { dataset: { turnKey: key.current }, getBoundingClientRect: () => ({ top: 100, bottom: 700, height: 600 }),
    __reactFiber$test: { return: list } };
  element.__reactFiber$test = { memoizedProps: { value: {
    getScrollElement: () => element, getLastScrollDistanceFromBottomPx: () => 1000 - top,
    shouldFollowContentGrowth: () => true, getResponseSpacer: () => ({ getHeightPx: () => 0 }),
  } } };
  const document = { querySelectorAll: () => [element], hasFocus: () => true, visibilityState: 'visible', defaultView: {
    performance: { now: () => ++clock }, queueMicrotask: fn => microtasks.push(fn),
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id),
  } };
  const client = { addNotificationCallback(_methods, fn) { notify = fn; return () => { notify = null; }; } };
  return { records, errors, calls, element, proto, ref, key, phase, entries, follow, result, nativeError, frames, listeners,
    flush() { while (microtasks.length) microtasks.shift()(); },
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    notify: value => notify(value),
    start(report = batch => records.push(...batch)) { return installScrollDiagnostics(document, client, report, (error, info) => errors.push({ error, info }), 'run'); },
  };
}

test('installation only observes and has no interval, scroll, DOM drawing or queued frame', () => {
  const f = fixture(), probe = f.start(); f.flush();
  assert.equal(probe.status().enabled, true);
  assert.equal(probe.status().surfaces, 1);
  assert.deepEqual(f.calls, []);
  assert.equal(f.element.scrollTop, 500);
  assert.equal(f.frames.size, 0);
  const count = f.records.length; probe.refresh(); f.flush();
  assert.equal(f.records.length, count);
  probe.cleanup();
});

test('native scroll receiver, exact arguments, return object and exceptions are preserved', () => {
  const f = fixture(), probe = f.start(), options = { top: 700, behavior: 'instant' };
  assert.equal(f.element.scrollTo(options), f.result);
  assert.deepEqual(f.calls, [{ receiver: f.element, args: [options] }]);
  assert.throws(() => f.element.scrollTo({ fail: true }), error => error === f.nativeError);
  f.flush();
  const call = f.records.find(record => record.kind === 'scroll-call');
  assert.equal(call.before.top, 500); assert.equal(call.state.top, 700); assert.ok(call.stack.includes('scroll-diagnostics.test'));
  assert.deepEqual(f.errors, []); probe.cleanup();
});

test('scrollTop assignments are observed and cleanup restores inherited accessors and current native refs', () => {
  const f = fixture(), probe = f.start();
  f.element.scrollTop = 450; f.ref.current = { followMode: 'static' }; f.phase.current = 'idle';
  f.flush();
  assert.ok(f.records.some(record => record.kind === 'scroll-call' && record.method === 'scrollTop' && record.top === 450));
  assert.ok(f.records.some(record => record.kind === 'ref-write' && record.ref === 'follow' && record.previous === 'user_follow' && record.next === 'static'));
  probe.cleanup();
  assert.equal(Object.hasOwn(f.element, 'scrollTop'), false);
  assert.equal(f.element.scrollTo, f.proto.scrollTo);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.ref, 'current').value, { followMode: 'static' });
  assert.equal(f.listeners.size, 0);
});

test('repeated no-op calls and unchanged refreshes do not append records', () => {
  const f = fixture(), probe = f.start(); f.flush(); const count = f.records.length;
  for (let i = 0; i < 10; i++) { f.element.scrollTo({ top: 500 }); f.element.scrollTop = 500; probe.refresh(); }
  f.flush(); assert.equal(f.records.length, count);
  f.element.scrollTo({ top: 800 }); f.flush();
  assert.equal(f.records.at(-1).noops, 20); probe.cleanup();
});

test('unchanged fractional-pixel scroll requests are recorded once, and unrelated threads schedule no work', () => {
  const f = fixture();
  f.proto.scrollTo = options => { f.element.scrollTop = Math.round(options.top); return f.result; };
  const probe = f.start(); f.flush(); const count = f.records.length;
  for (let i = 0; i < 10; i++) f.element.scrollTo({ top: 500.0001, behavior: 'instant' });
  f.notify({ method: 'turn/completed', params: { threadId: 'unrelated' } }); f.flush();
  assert.equal(f.records.length, count + 1);
  assert.equal(f.frames.size, 0); probe.cleanup();
});

test('turn completion, replacement keys, post-commit frame and user scroll remain observable across turns', () => {
  const f = fixture(), probe = f.start();
  f.notify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'current', status: 'completed', text: 'private event text' } } });
  f.entries[1] = { turnKey: 'turn:current', turnId: 'current', turnStatus: 'completed' }; f.key.current = 'turn:current'; f.phase.current = 'idle';
  f.listeners.get('scroll')(); assert.equal(f.frames.size, 1); f.frame(); f.flush();
  assert.ok(f.records.some(record => record.kind === 'notification' && record.turnId === 'current'));
  assert.ok(f.records.some(record => record.kind === 'ref-write' && record.ref === 'latest-key' && record.previous === 'tail:current' && record.next === 'turn:current'));
  assert.ok(f.records.some(record => record.kind === 'frame' && record.state.entries.at(-1).status === 'completed'));
  assert.ok(!JSON.stringify(f.records).includes('private'));
  f.notify({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'second', status: 'inProgress' } } }); f.flush();
  assert.ok(f.records.some(record => record.turnId === 'second'));
  assert.equal(probe.status().enabled, true); probe.cleanup();
});

test('diagnostic reporting failure disables only diagnostics, preserving native scrolling and original error', () => {
  const f = fixture(), failure = new TypeError('log binding lost'), probe = f.start(() => { throw failure; });
  f.flush(); assert.equal(probe.status().enabled, false);
  assert.equal(f.errors[0].error, failure); assert.equal(f.errors[0].info.stack, failure.stack);
  assert.equal(f.element.scrollTo({ top: 900 }), f.result);
  assert.equal(f.element.scrollTop, 900);
});

test('cleanup cancels pending work and does not replace a later component hook', () => {
  const f = fixture(), probe = f.start();
  f.listeners.get('scroll')(); const later = () => 'later'; f.element.scrollTo = later;
  probe.cleanup(); f.flush(); assert.equal(f.frames.size, 0); assert.equal(f.element.scrollTo, later);
});
