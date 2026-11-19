import test from 'node:test';
import assert from 'node:assert/strict';
import { kitModule } from 'codex-toolkit-core/kits';
import { installFileLineHighlight } from '../src/file-line-highlight.mjs';
import kit from '../kits/file-line-highlight/index.mjs';

function fixture({ autoInstall = true } = {}) {
  const listeners = new Map();
  const measures = [];
  const calls = [];
  const original = function (line) { calls.push({ owner: this, line }); return 'native-result'; };
  const controller = {
    filePath: '/S:/dev/test.md', lineToReveal: null,
    revealLine() {}, onLineRevealHandled: original,
    editorView: { requestMeasure: (request) => measures.push(request), lineBlockAt() {} },
  };
  const editor = { isConnected: true, __reactFiber$test: { memoizedState: { memoizedState: { current: controller } } } };
  const main = { closest: () => null }; let mounted = true;
  const document = {
    querySelectorAll: selector => selector.startsWith('main.') ? mounted ? [main] : [] : [editor],
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
    defaultView: { location: { pathname: '/' }, addEventListener() {}, removeEventListener() {} },
  };
  const feature = autoInstall ? installFileLineHighlight(document) : null;
  const click = (href, extras = {}) => listeners.get('click')({
    button: 0,
    target: { closest: () => ({ closest: () => true, getAttribute: () => href }) },
    ...extras,
  });
  return { document, feature, controller, original, measures, calls, click, listeners, setMounted: value => { mounted = value; } };
}

test('native line-reveal callback is preserved and only matching chat links schedule a highlight', () => {
  const f = fixture();
  f.click('S:\\dev\\test.md:13');
  assert.equal(f.controller.onLineRevealHandled(13), 'native-result');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].owner, f.controller);
  assert.equal(f.measures.length, 1);
  f.controller.onLineRevealHandled(13);
  assert.equal(f.measures.length, 1);
  f.feature.cleanup();
  assert.equal(f.controller.onLineRevealHandled, f.original);
});

test('initial native reveal completed before attachment is recovered once when the editor becomes available', () => {
  const f = fixture();
  f.click('S:/dev/test.md#L20');
  f.feature.refresh();
  f.feature.refresh();
  assert.equal(f.measures.length, 1);
  assert.equal(f.calls.length, 0);
});

test('unrelated files and modified clicks do not highlight; a link without a line clears the pending request', () => {
  const f = fixture();
  f.click('S:/dev/other.md:13');
  f.controller.onLineRevealHandled(13);
  assert.equal(f.measures.length, 0);
  f.click('S:/dev/test.md:13', { ctrlKey: true });
  f.controller.onLineRevealHandled(13);
  assert.equal(f.measures.length, 0);
  f.click('S:/dev/test.md:13');
  f.click('S:/dev/test.md');
  f.feature.refresh();
  assert.equal(f.measures.length, 0);
});

test('original native errors are not swallowed or replaced by a highlight', () => {
  const f = fixture();
  f.feature.cleanup();
  const error = new TypeError('native reveal failed');
  f.controller.onLineRevealHandled = () => { throw error; };
  const doc = { querySelectorAll: () => [{ isConnected: true, __reactFiber$test: { memoizedState: { memoizedState: { current: f.controller } } } }], addEventListener() {}, removeEventListener() {}, defaultView: { addEventListener() {}, removeEventListener() {} } };
  const feature = installFileLineHighlight(doc);
  assert.throws(() => f.controller.onLineRevealHandled(13), (actual) => actual === error);
  feature.cleanup();
});

test('packaged Kit owns the native callback only while the chat surface is mounted', async () => {
  const source = kitModule(kit), definition = (await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))).default;
  const f = fixture({ autoInstall: false }); let refresh, unsubscribed = false;
  const instance = definition.create({ document: f.document, onDomChange(callback) { refresh = callback; return () => { unsubscribed = true; }; } }, definition.helpers);
  f.click('S:/dev/test.md:13'); assert.equal(f.controller.onLineRevealHandled(13), 'native-result'); assert.equal(f.measures.length, 1);
  f.setMounted(false); refresh(); assert.equal(f.controller.onLineRevealHandled, f.original); assert.equal(f.listeners.size, 0);
  f.setMounted(true); refresh(); assert.notEqual(f.controller.onLineRevealHandled, f.original);
  instance.close(); assert.equal(unsubscribed, true); assert.equal(f.controller.onLineRevealHandled, f.original); assert.equal(f.listeners.size, 0);
});
