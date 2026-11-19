import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCss, composerTimerCss } from '../src/styles.mjs';
import { nativeComposerTiming, createRpcComposerTiming, nativeWorkedTiming, loadNativeDurationFormatter, composerIsWorking } from '../src/composer-timer.mjs';

const client = (turns, execution) => ({ getConversation: () => ({ turnHistory: { history: { entitiesByKey: Object.fromEntries(turns.map((t) => [t.turnId, t])) } } }), getThreadExecutionState: () => execution });

const formatterDocument = { scripts: [{ src: 'app://-/assets/index-test.js' }] };
function nativeFormatter(ms, { underOneSecond = 'null', trimZeroUnits = false } = {}) {
  return Math.floor(ms / 1000) || (underOneSecond === 'zero' && trimZeroUnits ? 0 : null);
}
function wrapper(ms, locale) { return nativeFormatter(ms, { locale, underOneSecond: 'zero', trimZeroUnits: true }); }
const sourceResponse = (source) => ({ ok: true, text: async () => source });

test('duration formatter remains compatible with the original app-initial export', async () => {
  const result = await loadNativeDurationFormatter(formatterDocument, {
    fetchModule: async () => sourceResponse('app-initial-test.js'),
    importModule: async () => ({ wrapper, nativeFormatter }),
  });
  assert.equal(result, nativeFormatter);
});

test('duration formatter follows app-primary relocation and excludes the locale wrapper', async () => {
  const imports = [];
  const result = await loadNativeDurationFormatter(formatterDocument, {
    fetchModule: async (url) => sourceResponse(url.includes('/index-') ? 'app-initial-test.js' : 'app-primary-test.js'),
    importModule: async (url) => {
      imports.push(url);
      return url.includes('/app-primary-') ? { wrapper, nativeFormatter } : {};
    },
  });
  assert.equal(result, nativeFormatter);
  assert.deepEqual(imports, ['app://-/assets/app-initial-test.js', 'app://-/assets/app-primary-test.js']);
});

test('unexpected module import failures retain the original error', async () => {
  const error = new TypeError('broken native module');
  await assert.rejects(loadNativeDurationFormatter(formatterDocument, {
    fetchModule: async () => sourceResponse('app-initial-test.js'),
    importModule: async () => { throw error; },
  }), (actual) => actual === error);
});

test('duration formatter follows the upgraded index to app-main to app-initial chain', async () => {
  const formatter = await loadNativeDurationFormatter(formatterDocument, {
    fetchModule: async url => sourceResponse(url.includes('/index-') ? 'app-main-build.js' : 'app-initial-build.js'),
    importModule: async url => { assert.equal(url, 'app://-/assets/app-initial-build.js'); return { nativeFormatter }; },
  });
  assert.equal(formatter, nativeFormatter);
});

test('running display is derived from native timing, never latched by its previous inactive display', () => {
  const evaluate = (active, source) => composerIsWorking({ active, turnId: 'same-turn' }, source);
  assert.equal(evaluate(true, null), true);
  assert.equal(evaluate(true, { status: 'working', completedAtMs: null }), true);
  assert.equal(evaluate(true, { status: 'worked', completedAtMs: 5000 }), false);
  assert.equal(evaluate(false, { status: 'working', completedAtMs: null }), false);
});

test('timing diagnostics distinguish missing RPC, lifecycle receipt and raw reads without message contents', async () => {
  let rpc; const diagnostics = [], failures = [];
  const control = createRpcComposerTiming(() => rpc, nativeComposerTiming, () => {}, error => failures.push(error), record => diagnostics.push(record));
  control.read('thread'); control.read('thread');
  assert.equal(diagnostics.filter(r => r.kind === 'waiting-for-rpc').length, 1);
  const started = Date.now() - 5000;
  rpc = { getThreadExecutionState: async () => ({ inProgress: true, activeTurnId: 'turn' }), getLatestTurnId: async () => 'turn',
    getTurnById: async () => ({ turnId: 'turn', status: 'inProgress', turnStartedAtMs: started, items: [{ text: 'DO NOT LOG THIS' }] }) };
  control.ready(); await new Promise(setImmediate);
  control.receive('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', durationMs: 5500, items: [{ text: 'DO NOT LOG THIS' }] } });
  await new Promise(setImmediate);
  assert.ok(diagnostics.some(r => r.kind === 'notification' && r.method === 'turn/completed'));
  assert.ok(diagnostics.some(r => r.kind === 'rpc-read' && r.inProgress && r.completionObserved && r.active === false));
  assert.equal(control.status().entries[0].lastRead.active, false);
  assert.equal(JSON.stringify(diagnostics).includes('DO NOT LOG THIS'), false);
  const count = diagnostics.length; for (let i = 0; i < 20; i++) control.read('thread');
  assert.equal(diagnostics.length, count); assert.deepEqual(failures, []); control.cleanup();
});

test('missing formatter still reports an interface gap', async () => {
  await assert.rejects(loadNativeDurationFormatter(formatterDocument, {
    fetchModule: async (url) => sourceResponse(url.includes('/index-') ? 'app-initial-test.js' : 'app-primary-test.js'),
    importModule: async () => ({ wrapper }),
  }), /Native duration formatter export changed/);
});

test('an absent native conversation is not an interface gap; malformed state still is', async () => {
  let execution = null, latest;
  const failures = [], diagnostics = [];
  const rpc = { getThreadExecutionState: async () => execution, getLatestTurnId: async () => latest,
    getTurnById: async () => ({ turnId: 'turn', status: 'inProgress', turnStartedAtMs: 1000 }) };
  const timing = createRpcComposerTiming(() => rpc, nativeComposerTiming, () => {}, error => failures.push(error), value => diagnostics.push(value));
  timing.read('1'); await new Promise(setImmediate);
  assert.equal(timing.status().error, null);
  assert.equal(timing.read('1'), null);
  assert.ok(diagnostics.some(value => value.kind === 'conversation-unavailable'));
  execution = { inProgress: true, activeTurnId: 'turn' }; latest = 'turn';
  timing.receive('turn/started', { threadId: '1', turn: { id: 'turn' } });
  await new Promise(setImmediate);
  assert.equal(timing.read('1').active, true);
  execution = {};
  timing.read('malformed'); await new Promise(setImmediate);
  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof TypeError);
  assert.match(failures[0].message, /Native composer execution state changed: malformed/);
  timing.cleanup();
});
test('active elapsed time comes from the native turn start, not injection time', () => {
  const c = client([{ turnId: 'a', turnStartedAtMs: 1000, finalAssistantStartedAtMs: 2000, status: 'inProgress' }], { activeTurnId: 'a', inProgress: true });
  assert.deepEqual(nativeComposerTiming(c, 'thread', 5000), { turnId: 'a', active: true, startedAtMs: 1000, elapsedMs: 4000 });
});
test('completed time stays fixed at the same final-response boundary as Worked for', () => {
  const c = client([{ turnId: 'a', turnStartedAtMs: 1000, finalAssistantStartedAtMs: 4000, durationMs: 5000, status: 'completed' }], { inProgress: false });
  assert.equal(nativeComposerTiming(c, 'thread', 10000).elapsedMs, 3000);
  assert.equal(nativeComposerTiming(c, 'thread', 20000).elapsedMs, 3000);
});
test('interrupted turn without final response freezes at native duration', () => {
  const c = client([{ turnId: 'a', turnStartedAtMs: 1000, durationMs: 3000, status: 'interrupted' }], { inProgress: false });
  assert.equal(nativeComposerTiming(c, 'thread', 10000).elapsedMs, 3000);
});
test('latest cached turn is selected by time; missing time is not fabricated', () => {
  const c = client([{ turnId: 'new', turnStartedAtMs: 2000, durationMs: 1000, status: 'completed' }, { turnId: 'old', turnStartedAtMs: 1000, durationMs: 9000, status: 'completed' }], { inProgress: false });
  assert.equal(nativeComposerTiming(c, 'thread').turnId, 'new');
  assert.equal(nativeComposerTiming(client([], {}), 'thread'), null);
});

test('Working for status follows the committed React tree, not the stale alternate', () => {
  const stateNode = {};
  const oldRoot = { stateNode }, currentRoot = { stateNode };
  stateNode.current = currentRoot;
  const old = { memoizedProps: {}, return: { memoizedProps: { status: 'worked', startedAtMs: 1000, completedAtMs: 2000 }, return: oldRoot } };
  const current = { memoizedProps: {}, return: { memoizedProps: { status: 'working', startedAtMs: 1000, completedAtMs: null }, return: currentRoot } };
  oldRoot.child = old;
  currentRoot.child = current;
  old.alternate = current;
  const element = { __reactFiber$test: old };
  const turn = { getAttribute: () => 'a', querySelectorAll: () => [element] };
  const viewport = { querySelectorAll: () => [turn] };
  assert.equal(nativeWorkedTiming(viewport, 'a', 5000).status, 'working');
  stateNode.current = oldRoot;
  assert.deepEqual(nativeWorkedTiming(viewport, 'a', 5000), { status: 'worked', startedAtMs: 1000, completedAtMs: 2000, elapsedMs: 1000 });
});

test('shared return chains do not revive a completed Working for alternate', () => {
  const root = { stateNode: {} };
  root.stateNode.current = root;
  const stale = { memoizedProps: {}, return: { memoizedProps: { status: 'working', startedAtMs: 1000, completedAtMs: null }, return: root } };
  const committed = { memoizedProps: {}, return: { memoizedProps: { status: 'worked', startedAtMs: 1000, completedAtMs: 4000 }, return: root } };
  stale.alternate = committed;
  root.child = committed;
  const turn = { getAttribute: () => 'a', querySelectorAll: () => [{ __reactFiber$test: stale }] };
  const viewport = { querySelectorAll: () => [turn] };
  assert.deepEqual(nativeWorkedTiming(viewport, 'a', 10000), { status: 'worked', startedAtMs: 1000, completedAtMs: 4000, elapsedMs: 3000 });
});

test('RPC timing initializes from native state, freezes on completion and never polls on reads', async () => {
  const turn = { turnId: 'a', turnStartedAtMs: 1000, status: 'inProgress' }, execution = { inProgress: true, activeTurnId: 'a' };
  let calls = 0; const changes = [], failures = [];
  const rpc = { getLatestTurnId: async () => { calls++; return 'a'; }, getThreadExecutionState: async () => { calls++; return { ...execution }; },
    getTurnById: async (thread, id) => { calls++; assert.equal(thread, 'thread'); assert.equal(id, 'a'); return { ...turn }; } };
  const control = createRpcComposerTiming(() => rpc, (client, id) => nativeComposerTiming(client, id, 5000), id => changes.push(id), error => failures.push(error));
  assert.equal(control.read('thread'), null); await new Promise(setImmediate);
  assert.deepEqual(control.read('thread'), { turnId: 'a', active: true, startedAtMs: 1000, elapsedMs: 4000 });
  for (let i = 0; i < 10; i++) control.read('thread'); assert.equal(calls, 3);
  control.receive('thread/status/changed', { threadId: 'another' }); assert.equal(calls, 3);
  turn.status = 'completed'; turn.finalAssistantStartedAtMs = 4000; execution.inProgress = false; execution.activeTurnId = null;
  control.receive('turn/completed', { threadId: 'thread' }); await new Promise(setImmediate);
  assert.equal(control.read('thread').elapsedMs, 3000); assert.equal(control.read('thread').active, false);
  assert.equal(calls, 6); assert.equal(changes.length, 2); assert.deepEqual(failures, []); control.cleanup();
});

test('RPC timing waits for discovery and retains a lifecycle change received during a pending read', async () => {
  let rpc, finish, reads = 0; const changes = [];
  const control = createRpcComposerTiming(() => rpc, (client, id) => nativeComposerTiming(client, id, 5000), id => changes.push(id), error => { throw error; });
  assert.equal(control.read('thread'), null);
  rpc = { getThreadExecutionState: async () => ({ inProgress: false }), getLatestTurnId: async () => 'a',
    async getTurnById() { reads++; if (reads === 1) await new Promise(resolve => { finish = resolve; }); return { turnId: 'a', turnStartedAtMs: 1000, durationMs: 2000, status: 'completed' }; } };
  control.ready(); await new Promise(setImmediate);
  control.receive('turn/completed', { threadId: 'thread' }); finish(); await new Promise(setImmediate);
  assert.equal(reads, 2); assert.equal(changes.length, 1); assert.equal(control.read('thread').elapsedMs, 2000); control.cleanup();
});

test('completion freezes immediately and a stale native snapshot cannot restart that turn', async () => {
  let turn = { turnId: 'a', turnStartedAtMs: 1000, finalAssistantStartedAtMs: 4000, status: 'inProgress' };
  let execution = { inProgress: true, activeTurnId: 'a' }, calls = 0;
  const rpc = { getThreadExecutionState: async () => ({ ...execution }), getLatestTurnId: async () => turn.turnId,
    getTurnById: async () => { calls++; return { ...turn }; } };
  const control = createRpcComposerTiming(() => rpc, (client, id) => nativeComposerTiming(client, id, 5000), () => {}, error => { throw error; });
  control.read('thread'); await new Promise(setImmediate);
  assert.equal(control.read('thread').active, true);
  control.receive('turn/completed', { threadId: 'thread', turn: { id: 'a', status: 'completed', durationMs: 4500 } });
  assert.deepEqual(control.read('thread'), { turnId: 'a', active: false, startedAtMs: 1000, elapsedMs: 3000 });
  await new Promise(setImmediate);
  assert.equal(control.read('thread').active, false);
  assert.equal(control.read('thread').elapsedMs, 3000);
  for (let i = 0; i < 10; i++) control.read('thread');
  assert.equal(calls, 2);
  turn = { turnId: 'b', turnStartedAtMs: 6000, status: 'inProgress' }; execution = { inProgress: true, activeTurnId: 'b' };
  control.receive('turn/started', { threadId: 'thread', turn: { id: 'b' } }); await new Promise(setImmediate);
  assert.equal(control.read('thread').turnId, 'b'); assert.equal(control.read('thread').active, true);
  control.receive('turn/completed', { threadId: 'thread', turn: { id: 'a', status: 'completed' } }); await new Promise(setImmediate);
  assert.equal(control.read('thread').turnId, 'b'); assert.equal(control.read('thread').active, true);
  control.cleanup();
});

test('completion during an in-flight read wins over its stale response and uses native stop duration', async () => {
  let release, calls = 0;
  const turn = { turnId: 'a', turnStartedAtMs: 1000, status: 'inProgress' };
  const rpc = { getThreadExecutionState: async () => ({ inProgress: true, activeTurnId: 'a' }), getLatestTurnId: async () => 'a',
    async getTurnById() { calls++; if (calls === 2) await new Promise(resolve => { release = resolve; }); return { ...turn }; } };
  const control = createRpcComposerTiming(() => rpc, (client, id) => nativeComposerTiming(client, id, 5000), () => {}, error => { throw error; });
  control.read('thread'); await new Promise(setImmediate);
  control.receive('thread/status/changed', { threadId: 'thread', status: { type: 'idle' } }); await new Promise(setImmediate);
  control.receive('turn/completed', { threadId: 'thread', turn: { id: 'a', status: 'interrupted', durationMs: 3500 } });
  assert.equal(control.read('thread').active, false); assert.equal(control.read('thread').elapsedMs, 3500);
  release(); await new Promise(setImmediate);
  assert.equal(control.read('thread').active, false); assert.equal(control.read('thread').elapsedMs, 3500);
  assert.equal(calls, 3);
  control.receive('turn/completed', { threadId: 'thread', turnId: 'a' }); await new Promise(setImmediate);
  assert.equal(control.read('thread').active, false); assert.equal(control.read('thread').elapsedMs, 3500);
  control.cleanup();
});

test('RPC timing errors preserve their original identity without retrying or clearing the last result', async () => {
  const failure = new TypeError('native timing schema changed'), failures = []; let calls = 0;
  const rpc = { getThreadExecutionState: async () => ({ inProgress: false }), getLatestTurnId: async () => 'a',
    async getTurnById() { calls++; throw failure; } };
  const control = createRpcComposerTiming(() => rpc, nativeComposerTiming, () => assert.fail('No fabricated time'), error => failures.push(error));
  control.read('thread'); await new Promise(setImmediate);
  assert.equal(failures[0], failure); assert.equal(control.status().error, failure.message);
  control.receive('turn/completed', { threadId: 'thread' }); control.read('thread'); await new Promise(setImmediate);
  assert.equal(calls, 1); control.cleanup();
});

test('legacy CSS hands off only the composer timer styling', () => {
  assert.equal(chatCss(false, ['composer-timer']), chatCss().replace(composerTimerCss(), ''));
});
