import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { kitModule } from 'codex-toolkit-core/kits';
import fast from '../kits/fast-mode-indicator/index.mjs';
import { readComposerModelSelection, sameModelSelection, installModelDecorations } from '../src/model-decorations.mjs';

test('model warning compares model and effort, deliberately not service tier', () => {
  const base = { model: 'Sol', effort: 'xhigh', available: true, fast: false };
  assert.equal(sameModelSelection(base, { ...base, fast: true, model: 'sol' }), true);
  assert.equal(sameModelSelection(base, { ...base, effort: 'high' }), false);
  assert.equal(sameModelSelection(base, { ...base, model: 'Luna' }), false);
  assert.equal(sameModelSelection(base, { ...base, available: false }), false);
  assert.equal(sameModelSelection({ ...base, effort: '' }, { ...base, effort: '' }), false);
});

test('fast tooltip changes in place without rereading the model selection', () => {
  let locale = 'en', reads = 0; const children = [];
  const anchor = { parentElement: null, appendChild(node) { children.push(node); node.parentElement = this; } };
  const editor = { closest: selector => selector.includes('ComposerLayout') ? anchor : selector === 'main' ? anchor : null, getClientRects: () => [{}] };
  const trigger = { closest: () => null, getClientRects: () => [{}] };
  const view = { queueMicrotask, getComputedStyle: () => ({ visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} } };
  const document = { defaultView: view, querySelectorAll: selector => selector.startsWith('[data-codex-intelligence') ? [trigger] : selector.startsWith('[role="textbox"]') ? [editor] : [],
    createElement: () => ({ dataset: {}, setAttribute() {}, remove() {} }) };
  const packed = new vm.Script(kitModule(fast).replace(/^export default /, '')).runInNewContext();
  const control = packed.helpers.installModelDecorations(document, { currentThread: () => 'thread', bridge: {}, onError() {}, features: { emoji: false, fast: true, warning: false }, fastLabel: () => locale === 'en' ? 'Fast' : '快速' },
    () => { reads++; return { model: 'Sol', effort: 'high', fast: true, available: true }; }, sameModelSelection);
  control.refresh(); const icon = children[0]; assert.equal(icon.title, 'Sol · high · Fast');
  const before = reads; locale = 'zh'; control.updateText(); assert.equal(children[0], icon); assert.equal(icon.title, 'Sol · high · 快速'); assert.equal(reads, before); control.cleanup();
});

test('model and fast state are read from the native picker rather than rollout or cached inference', () => {
  const content = { closest: () => null, querySelector: () => ({ textContent: ' Sol ' }) };
  const trigger = { dataset: {}, querySelectorAll: () => [content], __reactFiber$test: { return: { memoizedProps: { selectedLabelCandidate: { reasoningEffort: 'xhigh' }, selectedServiceTierIconKind: 'fast' } } } };
  assert.deepEqual(readComposerModelSelection(trigger), { model: 'Sol', effort: 'xhigh', fast: true, available: true });
  trigger.__reactFiber$test.return.memoizedProps.selectedServiceTierIconKind = null;
  assert.equal(readComposerModelSelection(trigger).fast, false);
  assert.equal(readComposerModelSelection(null).available, false);
});

test('the native reasoning-navigation picker shows Fast initially and follows native mutations', async () => {
  const children = [], observers = [];
  const anchor = { parentElement: null, appendChild(node) { children.push(node); node.parentElement = this; } };
  const editor = { closest: selector => selector.includes('ComposerLayout') || selector === 'main' ? anchor : null, getClientRects: () => [{}] };
  const content = { closest: () => null, querySelector: () => ({ textContent: 'GPT-6.1 Sol' }) };
  const selection = { selectedLabelCandidate: { reasoningEffort: 'max' }, selectedServiceTierIconKind: 'fast' };
  const trigger = { closest: () => null, getClientRects: () => [{}], querySelectorAll: () => [content], __reactFiber$native: { memoizedProps: selection } };
  const document = { defaultView: { queueMicrotask, getComputedStyle: () => ({ visibility: 'visible' }), MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} } },
    querySelectorAll: selector => selector.includes('[data-composer-navigation-target="reasoning"]') ? [trigger] : selector.startsWith('[role="textbox"]') ? [editor] : [],
    createElement() { return { dataset: {}, setAttribute() {}, remove() { const at = children.indexOf(this); if (at >= 0) children.splice(at, 1); } }; } };
  const control = installModelDecorations(document, { currentThread: () => 'thread', bridge: {}, onError(error) { if (error) throw error; }, features: { emoji: false, fast: true, warning: false } }, readComposerModelSelection, sameModelSelection);
  try {
    control.refresh(); assert.equal(children[0]?.textContent, '⚡'); assert.equal(children[0].title, 'GPT-6.1 Sol · max · Fast');
    selection.selectedServiceTierIconKind = null; observers[0](); await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 0);
    selection.selectedServiceTierIconKind = 'fast'; observers[0](); await new Promise(resolve => setImmediate(resolve));
    assert.equal(children[0]?.textContent, '⚡');
  } finally { control.cleanup(); }
});

test('main and side-chat warning selection share the current native picker locator', () => {
  let warned = false;
  const surface = { classList: { contains: () => warned, toggle(_name, value) { warned = value; }, remove() { warned = false; } }, dataset: {} };
  const main = { closest: () => null, getClientRects: () => [{}] }, child = { closest: selector => selector === '[role="tabpanel"]' ? panel : surface };
  const panel = { getAttribute: () => 'sidechat:child', getClientRects: () => [{}], querySelector: selector => selector.includes('[data-composer-navigation-target="reasoning"]') ? child : null };
  const document = { defaultView: { queueMicrotask, getComputedStyle: () => ({ visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} } },
    querySelectorAll: selector => selector.includes('[data-composer-navigation-target="reasoning"]') ? [main, child] : selector.startsWith('[role="tabpanel"]') ? [panel] : [] };
  const control = installModelDecorations(document, { currentThread: () => 'parent', bridge: {}, onError() {}, features: { emoji: false, fast: false, warning: true } },
    trigger => trigger ? { model: 'Sol', effort: 'max', fast: trigger === main, available: true } : { available: false }, sameModelSelection);
  try { control.refresh(); assert.equal(warned, true); assert.equal(surface.dataset.codexModelInheritanceWarning, 'true'); }
  finally { control.cleanup(); }
});

test('decorations keep host routing and metadata isolated when a local read finishes after navigation', async () => {
  let hostId = 'local', release;
  const calls = [], errors = [];
  const document = { querySelectorAll: () => [], defaultView: { queueMicrotask,
    MutationObserver: class { observe() {} disconnect() {} } } };
  const bridge = { appServer(_method, params, options) { calls.push({ params, options });
    return options.hostId === 'local' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ thread: { id: 'same', name: 'Remote' } }); } };
  const control = installModelDecorations(document, { currentThread: () => hostId + ':same', currentHost: () => hostId, bridge, onError: error => errors.push(error) },
    () => ({ available: false }), sameModelSelection);
  try {
    control.refresh(); hostId = 'durable'; control.refresh(); await new Promise(resolve => setImmediate(resolve));
    release({ thread: { id: 'same', name: 'Old local' } }); await new Promise(resolve => setImmediate(resolve)); control.refresh();
    assert.deepEqual(calls.map(value => value.options.hostId), ['local','durable']);
    assert.ok(calls.every(value => value.params.threadId === 'same')); assert.deepEqual(errors, []);
  } finally { control.cleanup(); }
});

test('a native turn event retries a timed-out title once and clears the recovered error', async () => {
  let calls = 0;
  const failure = new Error('mcp-response timed out.'), errors = [];
  const document = { querySelectorAll: () => [], defaultView: { queueMicrotask,
    MutationObserver: class { observe() {} disconnect() {} } } };
  const control = installModelDecorations(document, { currentThread: () => 'one',
    bridge: { async appServer() { if (++calls === 1) throw failure; return { thread: { id: 'one', name: 'Ready' } }; } },
    onError: error => errors.push(error) }, () => ({ available: false }), sameModelSelection);
  try {
    control.refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.at(-1), failure);
    control.refresh(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
    control.receive('turn/started', { threadId: 'one' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2); assert.equal(errors.at(-1), null);
    control.refresh(); assert.equal(calls, 2);
  } finally { control.cleanup(); }
});

test('title failures belong to their active thread and schema errors are not retried', async () => {
  let id = 'one'; const errors = [], calls = [];
  const document = { querySelectorAll: () => [], defaultView: { queueMicrotask,
    MutationObserver: class { observe() {} disconnect() {} } } };
  const control = installModelDecorations(document, { currentThread: () => id,
    bridge: { async appServer(_method, params) { calls.push(params.threadId); return { thread: { id: params.threadId === 'one' ? 'wrong' : 'two', name: 'Ready' } }; } },
    onError: error => errors.push(error) }, () => ({ available: false }), sameModelSelection);
  try {
    control.refresh(); await new Promise(resolve => setImmediate(resolve));
    const failure = errors.at(-1); assert.match(failure.message, /不同的会话 ID/);
    control.receive('turn/started', { threadId: 'one' }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['one']); assert.equal(errors.at(-1), failure);
    id = 'two'; control.refresh(); await new Promise(resolve => setImmediate(resolve)); assert.equal(errors.at(-1), null);
    id = 'one'; control.refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['one', 'two']); assert.equal(errors.at(-1), failure);
  } finally { control.cleanup(); }
});

test('a pending title retry retains its original failure until it succeeds', async () => {
  let calls = 0, release;
  const failure = new Error('mcp-response timed out.'), errors = [];
  const document = { querySelectorAll: () => [], defaultView: { queueMicrotask,
    MutationObserver: class { observe() {} disconnect() {} } } };
  const control = installModelDecorations(document, { currentThread: () => 'one',
    bridge: { appServer() { return ++calls === 1 ? Promise.reject(failure) : new Promise(resolve => { release = resolve; }); } },
    onError: error => errors.push(error) }, () => ({ available: false }), sameModelSelection);
  try {
    control.refresh(); await new Promise(resolve => setImmediate(resolve));
    control.receive('turn/started', { threadId: 'one' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2); assert.equal(errors.at(-1), failure);
    release({ thread: { id: 'one', name: 'Ready' } }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.at(-1), null);
  } finally { control.cleanup(); }
});

test('cleanup clears an instance-owned metadata failure before a healthy remount', async () => {
  const failure = new Error('mcp-response timed out.'), errors = [];
  const document = { querySelectorAll: () => [], defaultView: { queueMicrotask,
    MutationObserver: class { observe() {} disconnect() {} } } };
  const options = { currentThread: () => 'one', onError: error => errors.push(error) };
  const control = installModelDecorations(document, { ...options, bridge: { appServer: async () => { throw failure; } } }, () => ({ available: false }), sameModelSelection);
  control.refresh(); await new Promise(resolve => setImmediate(resolve)); assert.equal(errors.at(-1), failure);
  control.cleanup(); assert.equal(errors.at(-1), null);
  const next = installModelDecorations(document, { ...options, bridge: { appServer: async () => ({ thread: { id: 'one' } }) } }, () => ({ available: false }), sameModelSelection);
  try { next.refresh(); await new Promise(resolve => setImmediate(resolve)); assert.equal(errors.at(-1), null); }
  finally { next.cleanup(); }
});

test('a reopened child panel retries its own timeout without changing the main thread', async () => {
  let shown = true, calls = 0; const failure = new Error('mcp-response timed out.'), errors = [];
  const surface = { classList: { contains: () => false, remove() {} }, dataset: {} };
  const trigger = { closest: () => surface };
  const panel = { getAttribute: () => 'background-agent:child', querySelector: () => trigger, getClientRects: () => [{}] };
  const document = { querySelectorAll: selector => selector.startsWith('[role="tabpanel"]') && shown ? [panel] : [], defaultView: { queueMicrotask,
    getComputedStyle: () => ({ visibility: 'visible' }), MutationObserver: class { observe() {} disconnect() {} } } };
  const control = installModelDecorations(document, { currentThread: () => 'parent', features: { emoji: false, fast: false, warning: true },
    bridge: { async appServer() { if (++calls === 1) throw failure; return { thread: { id: 'child', parentThreadId: 'parent' } }; } },
    onError: error => errors.push(error) }, () => ({ available: false }), sameModelSelection);
  try {
    control.refresh(); await new Promise(resolve => setImmediate(resolve)); assert.equal(errors.at(-1), failure);
    shown = false; control.refresh(); assert.equal(errors.at(-1), null);
    shown = true; control.refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2); assert.equal(errors.at(-1), null);
  } finally { control.cleanup(); }
});
