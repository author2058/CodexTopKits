import test from 'node:test';
import assert from 'node:assert/strict';
import { publicReasoningSummaries, installReasoningSummaries } from '../src/reasoning-summaries.mjs';

test('includes every public summary part and skips empty later items', () => {
  const turn = { items: [
    { type: 'reasoning', id: 'one', summary: ['first line\nlast line', { text: 'second part' }] },
    { type: 'reasoning', id: 'two', summary: [] },
    { type: 'reasoning', id: 'three', summary: ['third summary'] },
    { type: 'agentMessage', id: 'four', text: 'not a summary' },
  ] };
  assert.deepEqual(publicReasoningSummaries(turn).map((s) => s.text), ['first line\nlast line', 'second part', 'third summary']);
});

test('updates an existing part without duplicating it even when its final line stays the same', () => {
  const item = { type: 'reasoning', id: 'one', summary: ['before\nsame last line'] };
  const before = publicReasoningSummaries({ items: [item] });
  item.summary[0] = 'changed first line\nsame last line';
  const after = publicReasoningSummaries({ items: [item] });
  assert.equal(before[0].key, after[0].key);
  assert.equal(after[0].text, item.summary[0]);
  assert.equal(after.length, 1);
});

test('does not access private reasoning content or manufacture summaries', () => {
  const item = { type: 'reasoning', id: 'empty', summary: [] };
  Object.defineProperty(item, 'content', { get() { throw new Error('Private content must not be read'); } });
  assert.deepEqual(publicReasoningSummaries({ items: [item] }), []);
  assert.deepEqual(publicReasoningSummaries(null), []);
});

function summaryHarness(props) {
  let frame, body;
  const header = { closest: () => null, querySelector: () => null,
    __reactFiber$test: { memoizedProps: props },
    get nextElementSibling() { return body; }, after(node) { body = node; } };
  const document = { defaultView: { requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame() {} },
    querySelectorAll: selector => selector === '[class~="group/activity-header"]' ? [header] : selector === '.codex-reasoning-summaries' && body ? [body] : [],
    createElement: () => ({ className: '', dataset: {}, children: [], hidden: false, textContent: '', setAttribute() {},
      classList: { contains: name => name === 'codex-reasoning-summaries' },
      insertBefore(node, before) { this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node); },
      remove() { body = null; } }),
  };
  return { document, header, body: () => body, frame: () => frame,
    flush: () => { const callback = frame; frame = null; callback(); } };
}

test('native turn props update public summaries without a renderer manager', () => {
  const turn = { turnId: 'turn', items: [{ id: 'reason', type: 'reasoning', summary: ['first'] }] };
  const harness = summaryHarness({ conversationId: 'thread', turn });
  const { document, flush } = harness;
  const control = installReasoningSummaries(document, () => null, publicReasoningSummaries);
  flush(); assert.equal(harness.body().children[0].textContent, 'first');
  assert.equal(control.status().nativeReady, true); assert.equal(control.status().nativeResolved, 1);
  const retained = harness.body().children[0]; turn.items[0].summary[0] = 'updated';
  control.refresh(); flush(); assert.equal(harness.body().children[0], retained); assert.equal(retained.textContent, 'updated');
  control.cleanup(); assert.equal(harness.body(), null);
});

test('missing turn props or IDs during React mount do not dereference undefined.items', () => {
  for (const props of [undefined, {}, { conversationId: 'thread' }, { turn: {} }, { turnId: 'turn' }]) {
    const harness = summaryHarness(props), errors = [];
    const control = installReasoningSummaries(harness.document, () => null, publicReasoningSummaries, error => errors.push(error));
    harness.flush();
    assert.equal(control.status().error, null); assert.deepEqual(errors, []);
    assert.equal(harness.body(), undefined); control.cleanup();
  }
});

test('unexpected summary failure reports its original error once and stops further work', () => {
  const original = new TypeError('native summary schema changed'), errors = [];
  const harness = summaryHarness({ conversationId: 'thread', turn: { turnId: 'turn', items: [] } });
  const control = installReasoningSummaries(harness.document, () => null, () => { throw original; }, error => errors.push(error));
  harness.flush();
  assert.deepEqual(errors, [original]); assert.equal(control.status().nativeReady, false);
  assert.equal(control.status().error, original.message);
  control.refresh(); assert.equal(harness.frame(), null); control.cleanup();
});
