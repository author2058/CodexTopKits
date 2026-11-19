import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantMessageOrdinals, messageLabelTime, messageOrdinalColor, installMessageLabels } from '../src/message-labels.mjs';

test('counts assistant text items only, including commentary and final answer', () => {
  const items = [
    { id: 'user', type: 'userMessage' },
    { id: 'a', type: 'agentMessage', phase: 'commentary', text: 'working' },
    { id: 'tool', type: 'commandExecution' },
    { id: 'reason', type: 'reasoning' },
    { id: 'empty', type: 'agentMessage', text: '' },
    { id: 'b', type: 'agentMessage', phase: 'final_answer', text: 'done' },
    { id: 'b', type: 'agentMessage', text: 'duplicate' },
  ];
  assert.deepEqual([...assistantMessageOrdinals({ items })], [['a', 1], ['b', 2]]);
  assert.deepEqual([...assistantMessageOrdinals({ items: [items[5]] })], [['b', 1]]);
});

test('partial historical turns do not masquerade as complete numbering', () => {
  const turn = { items: [{ id: 'late', type: 'agentMessage', text: 'last' }], itemsPagination: { hasLoadedOldest: false } };
  assert.equal(assistantMessageOrdinals(turn).size, 0);
  turn.itemsPagination.hasLoadedOldest = true;
  assert.equal(assistantMessageOrdinals(turn).get('late'), 1);
});

test('local 24-hour time has unpadded hours and padded minutes', () => {
  assert.equal(messageLabelTime(new Date(2026, 9, 7, 9, 5).getTime()), '9:05');
  assert.equal(messageLabelTime(new Date(2026, 9, 7, 0, 0).getTime()), '0:00');
  assert.equal(messageLabelTime(new Date(2026, 9, 7, 23, 59).getTime()), '23:59');
  assert.equal(messageLabelTime(null), '');
  assert.equal(messageLabelTime(NaN), '');
});

test('six opaque colors retain the former odd hues and repeat red through purple', () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => messageOrdinalColor(i + 1)),
    [0, 60, 120, 180, 240, 300].map(hue => 'hsl(' + hue + ' 100% 75%)'));
  assert.equal(messageOrdinalColor(7), messageOrdinalColor(1));
  assert.equal(messageOrdinalColor(12), messageOrdinalColor(6));
  assert.equal(messageOrdinalColor(13), messageOrdinalColor(1));
  assert.equal(new Set(Array.from({ length: 12 }, (_, i) => messageOrdinalColor(i + 1))).size, 6);
});

function labelHarness(nativeTurn, loadIndex, onError, { clientAvailable = true } = {}) {
  let mutation, frame; const nodes = [];
  const client = { getTurn(threadId, turnId) { assert.equal(threadId, 'thread'); assert.equal(turnId, 'real-turn'); return nativeTurn; }, getConversation: () => ({}),
    addAnyConversationMetaCallback: () => () => {}, addAcceptedHistoryListener: () => () => {}, addNotificationCallback: () => () => {} };
  const create = id => {
    const attrs = new Map([['data-response-annotation-conversation', 'thread'], ['data-response-annotation-target', id]]), classes = new Set(), styles = new Map();
    const writes = { attributes: 0, classes: 0 };
    return { nodeType: 1, attrs, writes, style: { getPropertyValue: name => styles.get(name) || '', setProperty: (name, value) => styles.set(name, value), removeProperty: name => styles.delete(name) },
      classList: { contains: name => classes.has(name), add(name) { writes.classes++; classes.add(name); }, remove(name) { writes.classes++; classes.delete(name); } },
      __reactFiber$test: { memoizedProps: { item: { type: 'assistant-message', sentAtMs: new Date(2026, 9, 14, 9, 5).getTime() }, turnId: 'real-turn' } },
      matches: () => true, querySelector: () => null, closest: selector => selector === '[data-content-search-turn-key]' ? { getAttribute: () => 'realtime-voice:real-turn:voice:display-key' } : null,
      getAttribute: key => attrs.get(key), hasAttribute: key => attrs.has(key), setAttribute(key, value) { writes.attributes++; attrs.set(key, value); }, removeAttribute(key) { writes.attributes++; attrs.delete(key); } };
  };
  const document = { defaultView: { MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} }, requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame() {} },
    getElementById: () => ({}), querySelectorAll: selector => selector === '[data-cdt-message-number]' ? nodes.filter(node => node.attrs.has('data-cdt-message-number')) : nodes };
  const labels = installMessageLabels(document, () => clientAvailable ? client : null, assistantMessageOrdinals, messageLabelTime, messageOrdinalColor, loadIndex, onError);
  return { nodes, create, labels, document, mutate(records) { mutation(records); }, flush() { const callback = frame; frame = null; callback?.(); },
    expand(node) { nodes.push(node); mutation([{ type: 'childList', addedNodes: [node], removedNodes: [] }]); } };
}

test('native transcript turn props preserve absolute numbering without a renderer manager', () => {
  const turn = { turnId: 'real-turn', status: 'inProgress', items: [
    { id: 'hidden', type: 'agentMessage', text: 'collapsed' }, { id: 'tool', type: 'commandExecution' },
    { id: 'visible', type: 'agentMessage', text: 'visible' },
  ] };
  const harness = labelHarness(null, null, null, { clientAvailable: false });
  const node = harness.create('visible');
  node.__reactFiber$test.return = { memoizedProps: { turn } };
  harness.nodes.push(node); harness.flush();
  assert.equal(node.attrs.get('data-cdt-message-number'), '2');
  assert.equal(harness.labels.status().nativeSubscribed, false);
  assert.equal(harness.labels.status().nativeReady, true);
  assert.equal(harness.labels.status().nativeResolved, 1);
  node.__reactFiber$test.return.memoizedProps.turn = { ...turn, items: [...turn.items, { id: 'new', type: 'agentMessage', text: 'new' }] };
  const next = harness.create('new'); next.__reactFiber$test.return = node.__reactFiber$test.return;
  harness.expand(next); harness.flush();
  assert.equal(next.attrs.get('data-cdt-message-number'), '3');
  harness.labels.cleanup();
});

test('a mounted assistant missing both native turn props and manager fails the readiness check', () => {
  const harness = labelHarness(null, null, null, { clientAvailable: false });
  harness.nodes.push(harness.create('a')); harness.flush();
  assert.equal(harness.labels.status().nativeReady, false);
  assert.equal(harness.labels.status().nativeResolved, 0);
  harness.labels.cleanup();
});

test('top-aligned labels and following tool rails share end anchors, update on mounts and clean up idempotently', () => {
  const h = labelHarness({ items: [{ id: 'a', type: 'agentMessage', text: 'first' }, { id: 'b', type: 'agentMessage', text: 'next' }] });
  const a = h.create('a'), b = h.create('b'), group = h.create('group');
  const tool = id => { const node = h.create(id); node.attrs.set('data-local-conversation-item-target-ids', id);
    node.matches = selector => selector.includes('data-local-conversation-item-target-ids'); return node; };
  const one = tool('one'), two = tool('two'), three = tool('three');
  const wrap = node => ({ hasAttribute: () => false, matches: () => false, querySelector: () => node });
  group.children = [wrap(a), one, two, wrap(b), three];
  for (const node of [a, b]) node.closest = selector => selector === '[class~="group/agent-activity"]' ? group : selector.includes('data-response-annotation') ? node : null;
  let block = h.create('paragraph');
  const markdown = { contains: node => node === block };
  a.querySelector = selector => selector.includes('data-markdown-text-style') ? markdown : null;
  h.document.defaultView.NodeFilter = { SHOW_TEXT: 4 };
  h.document.createTreeWalker = () => {
    let read = false;
    return { nextNode() { if (read) return null; read = true; return { textContent: 'first', parentElement: { closest: selector => selector.startsWith('button') ? null : block } }; } };
  };
  h.nodes.push(a, b); h.flush();
  assert.equal(block.attrs.get('data-cdt-message-number-label'), '1');
  assert.equal(a.hasAttribute('data-cdt-message-inline-number'), true);
  assert.equal(h.labels.status().toolRails, 3);
  assert.equal(one.style.getPropertyValue('--cdt-message-number-color'), messageOrdinalColor(1));
  assert.equal(two.style.getPropertyValue('--cdt-message-number-color'), messageOrdinalColor(1));
  assert.equal(three.style.getPropertyValue('--cdt-message-number-color'), messageOrdinalColor(2));
  assert.notEqual(one.style.getPropertyValue('--cdt-message-number-anchor'), three.style.getPropertyValue('--cdt-message-number-anchor'));
  assert.equal(a.style.getPropertyValue('--cdt-message-previous-end'), '--cdt-message-no-previous');
  assert.equal(b.style.getPropertyValue('--cdt-message-previous-end'), a.style.getPropertyValue('--cdt-message-end-anchor'));
  for (const node of [one, two]) assert.equal(node.style.getPropertyValue('--cdt-message-end-anchor'), a.style.getPropertyValue('--cdt-message-end-anchor'));
  assert.equal(three.style.getPropertyValue('--cdt-message-end-anchor'), b.style.getPropertyValue('--cdt-message-end-anchor'));
  const writes = [a, b, block, one, two, three, group].map(node => ({ ...node.writes }));
  h.labels.refresh(); h.flush();
  assert.deepEqual([a, b, block, one, two, three, group].map(node => node.writes), writes);
  const previous = block; block = h.create('replacement');
  h.mutate([{ type: 'childList', target: a, addedNodes: [], removedNodes: [] }]); h.flush();
  assert.equal(previous.hasAttribute('data-cdt-message-number-label'), false);
  assert.equal(block.attrs.get('data-cdt-message-number-label'), '1');
  const four = tool('four'); group.children.splice(2, 0, four);
  h.mutate([{ type: 'childList', target: group, addedNodes: [four], removedNodes: [] }]); h.flush();
  assert.equal(h.labels.status().toolRails, 4);
  assert.equal(four.style.getPropertyValue('--cdt-message-number-color'), messageOrdinalColor(1));
  group.children.splice(group.children.indexOf(two), 1);
  h.mutate([{ type: 'childList', target: group, addedNodes: [], removedNodes: [two] }]); h.flush();
  assert.equal(two.classList.contains('codex-message-tool-rail'), false);
  assert.equal(two.style.getPropertyValue('--cdt-message-end-anchor'), '');
  h.labels.cleanup();
  assert.equal(block.hasAttribute('data-cdt-message-number-label'), false);
  assert.equal(group.classList.contains('codex-message-rail-scope'), false);
  for (const node of [one, three, four]) assert.equal(node.classList.contains('codex-message-tool-rail'), false);
  for (const property of ['--cdt-message-host-anchor', '--cdt-message-number-box-anchor', '--cdt-message-end-anchor', '--cdt-message-previous-end']) assert.equal(a.style.getPropertyValue(property), '');
});

test('new native item wrappers extend rails through tools without coloring intervening user messages', () => {
  const h = labelHarness({ items: [{ id: 'a', type: 'agentMessage', text: 'first' }, { id: 'b', type: 'agentMessage', text: 'second' }] });
  const a = h.create('a'), b = h.create('b'), group = h.create('group');
  const wrapMessage = message => ({ hasAttribute: name => name === 'data-local-conversation-item-target-ids', matches: () => false,
    querySelector: selector => selector.includes('data-response-annotation') ? message : null });
  const item = (id, user = false) => { const node = h.create(id); node.attrs.set('data-local-conversation-item-target-ids', id); node.matches = () => false;
    node.querySelector = selector => user && selector.includes('data-conversation-role') ? {} : null; return node; };
  const firstTool = item('first-tool'), user = item('user', true), afterUser = item('after-user'), secondTool = item('second-tool');
  group.children = [wrapMessage(a), firstTool, user, afterUser, wrapMessage(b), secondTool];
  for (const node of [a, b]) node.closest = selector => selector === '[class~="group/agent-activity"]' ? group : null;
  h.nodes.push(a, b); h.flush();
  assert.equal(h.labels.status().toolRails, 2);
  assert.equal(firstTool.style.getPropertyValue('--cdt-message-end-anchor'), a.style.getPropertyValue('--cdt-message-end-anchor'));
  assert.equal(secondTool.style.getPropertyValue('--cdt-message-end-anchor'), b.style.getPropertyValue('--cdt-message-end-anchor'));
  assert.equal(b.style.getPropertyValue('--cdt-message-previous-end'), a.style.getPropertyValue('--cdt-message-end-anchor'));
  assert.equal(user.classList.contains('codex-message-tool-rail'), false);
  assert.equal(afterUser.classList.contains('codex-message-tool-rail'), false);
  h.labels.cleanup();
});

test('time midpoints link visible outputs only within the same turn and transcript pane', () => {
  const items = ['a', 'b', 'c', 'd'].map(id => ({ id, type: 'agentMessage', text: id }));
  const h = labelHarness({ items }), pane = {}, otherPane = {};
  const nodes = ['a', 'b', 'c', 'd'].map((id, index) => {
    const node = h.create(id), turnId = index === 0 ? 'first-turn' : 'next-turn';
    node.__reactFiber$test.memoizedProps.turnId = turnId;
    node.__reactFiber$test.return = { memoizedProps: { turn: { turnId, items } } };
    node.closest = selector => selector === '[data-thread-user-message-navigation-content]' ? (id === 'c' ? otherPane : pane) : null;
    return node;
  });
  h.nodes.push(...nodes); h.flush();
  assert.equal(nodes[1].style.getPropertyValue('--cdt-message-previous-end'), '--cdt-message-no-previous');
  assert.equal(nodes[2].style.getPropertyValue('--cdt-message-previous-end'), '--cdt-message-no-previous');
  assert.equal(nodes[3].style.getPropertyValue('--cdt-message-previous-end'), nodes[1].style.getPropertyValue('--cdt-message-end-anchor'));
  h.labels.cleanup();
});

test('a timestamp awaiting its historical ordinal still has its own positioning anchor', () => {
  const h = labelHarness({ items: [{ id: 'a', type: 'agentMessage', text: 'partial' }], itemsPagination: { hasLoadedOldest: false } });
  const a = h.create('a'); h.nodes.push(a); h.flush();
  assert.equal(a.hasAttribute('data-cdt-message-number'), false);
  assert.equal(a.getAttribute('data-cdt-message-time'), '9:05');
  assert.ok(a.style.getPropertyValue('--cdt-message-host-anchor'));
  h.labels.cleanup();
});

test('unchanged message labels and already-cleared messages do not rewrite observed DOM', () => {
  const harness = labelHarness({ items: [{ id: 'a', type: 'agentMessage', text: 'first' }] });
  const node = harness.create('a'); harness.nodes.push(node); harness.flush();
  const writes = { ...node.writes };
  harness.labels.refresh(); harness.flush();
  assert.deepEqual(node.writes, writes);
  node.__reactFiber$test.memoizedProps.item.type = 'user-message';
  harness.labels.refresh(); harness.flush();
  const cleared = { ...node.writes };
  harness.labels.refresh(); harness.flush();
  assert.deepEqual(node.writes, cleared);
  harness.labels.cleanup();
});

test('history expansion labels new messages without a native notification and prefers native turn ID over display key', () => {
  const { nodes, create, labels, flush, expand } = labelHarness({ items: [{ id: 'a', type: 'agentMessage', text: 'first' }, { id: 'b', type: 'agentMessage', text: 'last' }] });
  nodes.push(create('b'));
  flush();
  assert.equal(nodes[0].attrs.get('data-cdt-message-number'), '2');
  const expanded = create('a'); expand(expanded); flush();
  assert.equal(expanded.attrs.get('data-cdt-message-number'), '1');
  assert.equal(expanded.attrs.get('data-cdt-message-time'), '9:05');
  assert.equal(labels.status().domObserved, true);
  labels.cleanup(); assert.equal(labels.status().domObserved, false);
});

test('paginated history gets absolute ordinals and missing commentary times without loading native pages', async () => {
  const timestamp = new Date(2026, 9, 14, 3, 54).getTime();
  let loads = 0;
  const harness = labelHarness({ status: 'completed', items: [{ id: 'm54', type: 'agentMessage', text: 'final' }], itemsPagination: { hasLoadedOldest: false } }, async identity => {
    assert.deepEqual(identity, { threadId: 'thread', turnId: 'real-turn', anchorItemId: 'm54' });
    loads++;
    return { threadId: 'thread', turnId: 'real-turn', messages: Array.from({ length: 54 }, (_, i) => ({ itemId: 'm' + (i + 1), ordinal: i + 1, timestamp: i === 53 ? timestamp : new Date(2026, 9, 14, 0, 53).getTime() })) };
  });
  const final = harness.create('m54'); harness.nodes.push(final); harness.flush();
  assert.equal(final.attrs.get('data-cdt-message-number'), undefined);
  await new Promise(setImmediate); harness.flush();
  assert.equal(final.attrs.get('data-cdt-message-number'), '54');
  assert.equal(final.attrs.get('data-cdt-message-time'), '3:54');
  const commentary = harness.create('m1'); commentary.__reactFiber$test.memoizedProps.item.sentAtMs = null;
  harness.expand(commentary); harness.flush();
  assert.equal(commentary.attrs.get('data-cdt-message-number'), '1');
  assert.equal(commentary.attrs.get('data-cdt-message-time'), '0:53');
  assert.equal(loads, 1);
  harness.labels.cleanup();
});

test('complete historical commentary still gets its missing timestamp from the native index', async () => {
  const harness = labelHarness({ status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: 'first' }] }, async () => ({ threadId: 'thread', turnId: 'real-turn', messages: [{ itemId: 'a', ordinal: 1, timestamp: new Date(2026, 9, 14, 1, 7).getTime() }] }));
  const commentary = harness.create('a'); commentary.__reactFiber$test.memoizedProps.item.sentAtMs = null;
  harness.nodes.push(commentary); harness.flush(); await new Promise(setImmediate); harness.flush();
  assert.equal(commentary.attrs.get('data-cdt-message-number'), '1');
  assert.equal(commentary.attrs.get('data-cdt-message-time'), '1:07');
  harness.labels.cleanup();
});

test('an unexpected native index error remains visible with its original diagnostic', async () => {
  const original = new TypeError('native schema changed'); let received;
  const harness = labelHarness({ status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: 'first' }], itemsPagination: { hasLoadedOldest: false } }, async () => { throw original; }, error => { received = error; });
  harness.nodes.push(harness.create('a')); harness.flush(); await new Promise(setImmediate); harness.flush();
  assert.equal(received, original);
  assert.equal(harness.labels.status().error, 'native schema changed');
  assert.equal(harness.nodes[0].attrs.get('data-cdt-message-number'), undefined);
  harness.labels.cleanup();
});
