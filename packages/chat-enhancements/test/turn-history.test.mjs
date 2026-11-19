import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { kitModule } from 'codex-toolkit-core/kits';
import history from '../kits/history-show-all/index.mjs';
import { readTurnHistoryDisclosure, installTurnHistoryControl } from '../src/turn-history.mjs';

function harness({ expanded = true, complete = false, loader, rpc, text, install = installTurnHistoryControl } = {}) {
  let frame, mutation; const callbacks = [], nodes = []; let calls = [], unsubscribed = 0;
  const pagination = { hasLoadedOldest: complete, isLoadingOlder: false, olderCursor: complete ? null : 'older' };
  const classes = new Set();
  const row = { classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, value) => value ? classes.add(c) : classes.delete(c) },
    appendChild(node) { if (!nodes.includes(node)) nodes.push(node); node.parentElement = row; } };
  const disclosure = { nodeType: 1, isConnected: true, parentElement: row, expanded,
    getAttribute: key => key === 'aria-expanded' ? String(disclosure.expanded) : null,
    matches: () => true, querySelector: () => null,
    __reactFiber$test: { memoizedProps: { collapsedMessageCount: 42, workedDurationMs: 10000, isCollapsed: !expanded },
      return: { memoizedProps: { conversationId: 'thread', turnId: 'real-turn', turn: { turnId: 'real-turn', itemsPagination: pagination } } } } };
  const client = { pagination: { itemPagination: {
    getTurnPagination(thread, turn) { assert.equal(thread, 'thread'); assert.equal(turn, 'real-turn'); return pagination; },
    async loadTurnItems(...args) { calls.push(args); if (loader) return loader(pagination); pagination.hasLoadedOldest = true; pagination.olderCursor = null; },
  } }, addAnyConversationMetaCallback: callback => { callbacks.push(callback); return () => unsubscribed++; },
    addAcceptedHistoryListener: callback => { callbacks.push(callback); return () => unsubscribed++; } };
  const document = { defaultView: { requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame: () => { frame = null; },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} } }, getElementById: () => ({}),
    querySelectorAll: () => [disclosure], createElement: () => ({ dataset: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; }, remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); this.parentElement = null; } }) };
  const failures = [];
  const control = install(document, () => rpc ? null : client, readTurnHistoryDisclosure, (error, identity) => failures.push({ error, identity }), () => rpc, text);
  const flush = () => { const callback = frame; frame = null; callback?.(); };
  return { control, client, pagination, disclosure, nodes, classes, calls, failures, flush,
    toggle(value) { disclosure.expanded = value; mutation([{ type: 'attributes', target: disclosure }]); },
    meta() { callbacks[0](); }, unsubscribed: () => unsubscribed };
}

test('locale text updates the existing button without reloading history or replacing native errors', async () => {
  let locale = 'en'; const original = new Error('Original native error');
  const labels = { en: { show: 'Show all', loading: 'Loading', load: 'Load history' }, zh: { show: '显示全部', loading: '正在加载', load: '加载历史' } };
  const packed = new vm.Script(kitModule(history).replace(/^export default /, '')).runInNewContext();
  const h = harness({ loader: () => { throw original; }, text: key => labels[locale][key], install: packed.helpers.installTurnHistoryControl }); h.flush();
  const button = h.nodes[0]; assert.equal(button.textContent, 'Show all'); assert.equal(button.title, 'Load history');
  locale = 'zh'; h.control.updateText(); assert.equal(h.nodes[0], button); assert.equal(button.textContent, '显示全部'); assert.equal(button.title, '加载历史'); assert.equal(h.calls.length, 0);
  await assert.rejects(h.control.load(h.disclosure), error => error === original); h.flush();
  locale = 'en'; h.control.updateText(); assert.equal(button.textContent, 'Show all'); assert.equal(button.title, original.message); assert.equal(h.calls.length, 1); h.control.cleanup();
});

test('only expanded incomplete turns show the button, updating on disclosure and native history events', () => {
  const h = harness({ expanded: false }); h.flush();
  assert.equal(h.nodes.length, 0);
  h.toggle(true); h.flush();
  const button = h.nodes[0];
  assert.equal(button.textContent, '显示全部'); assert.equal(button.hidden, false);
  assert.equal(h.classes.has('codex-turn-history-row'), true);
  h.toggle(false); h.flush(); assert.equal(button.hidden, true);
  h.toggle(true); h.flush(); assert.equal(h.nodes[0], button); assert.equal(button.hidden, false);
  h.pagination.hasLoadedOldest = true; h.meta(); h.flush();
  assert.equal(button.hidden, true); assert.equal(h.classes.has('codex-turn-history-row'), false);
  h.control.cleanup(); assert.equal(h.nodes.length, 0); assert.equal(h.unsubscribed(), 2);
});

test('an expanded complete turn never creates a control', () => {
  const h = harness({ complete: true }); h.flush();
  assert.equal(h.nodes.length, 0); assert.equal(h.control.status().visible, 0); h.control.cleanup();
});

test('click loads only the selected turn once, disables while loading and hides when complete', async () => {
  let finish;
  const h = harness({ loader: async pagination => { await new Promise(resolve => { finish = resolve; }); pagination.hasLoadedOldest = true; pagination.olderCursor = null; } }); h.flush();
  const button = h.nodes[0]; let stopped = false, prevented = false;
  const job = button.onclick({ stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
  h.flush(); assert.equal(button.disabled, true); assert.equal(h.control.status().loading, 1);
  const duplicate = h.control.load(h.disclosure);
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, [['thread', 'real-turn', true]]);
  finish(); await Promise.all([job, duplicate]); h.flush();
  assert.equal(stopped, true); assert.equal(prevented, true); assert.equal(h.disclosure.expanded, true);
  assert.equal(button.hidden, true); assert.equal(h.control.status().loading, 0); h.control.cleanup();
});

test('the original native error remains visible, with no retries or false completion', async () => {
  const original = new TypeError('native history schema changed'); let fail = true;
  const h = harness({ loader: pagination => { if (fail) throw original; pagination.hasLoadedOldest = true; } }); h.flush();
  await assert.rejects(h.control.load(h.disclosure), error => error === original); h.flush();
  assert.equal(h.failures[0].error, original); assert.equal(h.nodes[0].title, original.message);
  assert.equal(h.nodes[0].hidden, false); assert.equal(h.nodes[0].disabled, false); assert.equal(h.calls.length, 1);
  assert.equal(h.control.status().error, original.message);
  fail = false; await h.control.load(h.disclosure); h.flush();
  assert.equal(h.control.status().error, null); assert.equal(h.nodes[0].hidden, true); h.control.cleanup();
});

test('a native loader returning without consuming all pages is a visible failure', async () => {
  const h = harness({ loader: () => {} }); h.flush();
  await assert.rejects(h.control.load(h.disclosure), /前页仍未加载完整/); h.flush();
  assert.equal(h.control.status().visible, 1); assert.equal(h.calls.length, 1); h.control.cleanup();
});

test('native identity is required; unrelated expanded controls do not qualify', () => {
  const client = { pagination: { itemPagination: { getTurnPagination: () => ({ hasLoadedOldest: false }) } } };
  const button = { getAttribute: () => 'true', __reactFiber$test: { memoizedProps: { conversationId: 'thread', turnId: 'turn' } } };
  assert.equal(readTurnHistoryDisclosure(button, client), null);
});

test('RPC pagination consumes only the selected turn until complete, without resuming or sending', async () => {
  const pages = [], turn = { turnId: 'real-turn', items: [{ id: 'last' }], itemsPagination: { hasLoadedOldest: false, olderCursor: 'two' } };
  let h;
  const rpc = {
    async getTurnById(threadId, turnId) { assert.equal(threadId, 'thread'); assert.equal(turnId, 'real-turn'); return structuredClone(turn); },
    async loadOlderConversationTurnsPage(threadId, options) {
      pages.push({ threadId, options });
      turn.items.unshift({ id: pages.length === 1 ? 'middle' : 'first' });
      turn.itemsPagination = pages.length === 1 ? { hasLoadedOldest: false, olderCursor: 'one' } : { hasLoadedOldest: true, olderCursor: null };
      Object.assign(h.pagination, turn.itemsPagination);
    },
  };
  h = harness({ rpc }); h.flush();
  assert.equal(h.control.status().nativeReady, true); assert.equal(h.nodes[0].hidden, false);
  await h.control.load(h.disclosure); h.flush();
  assert.deepEqual(pages, Array.from({ length: 2 }, () => ({ threadId: 'thread', options: { turnId: 'real-turn' } })));
  assert.equal(h.nodes[0].hidden, true); assert.equal(h.failures.length, 0); h.control.cleanup();
});

test('RPC pagination does not retry an unchanged page or erase an original exception', async () => {
  let calls = 0;
  const turn = { turnId: 'real-turn', items: [{ id: 'last' }], itemsPagination: { hasLoadedOldest: false } };
  const original = new TypeError('RPC schema changed'); let fail = false;
  const rpc = { getTurnById: async () => turn, async loadOlderConversationTurnsPage() { calls++; if (fail) throw original; } };
  const h = harness({ rpc }); h.flush();
  await assert.rejects(h.control.load(h.disclosure), /没有取得前一页/); assert.equal(calls, 1);
  fail = true; await assert.rejects(h.control.load(h.disclosure), error => error === original);
  assert.equal(calls, 2); assert.equal(h.failures.at(-1).error, original); h.control.cleanup();
});

test('stopping the control prevents a pending request from loading more pages', async () => {
  let finish, calls = 0;
  const turn = { turnId: 'real-turn', items: [{ id: 'last' }], itemsPagination: { hasLoadedOldest: false } };
  const rpc = { getTurnById: async () => turn, loadOlderConversationTurnsPage: async () => { calls++; await new Promise(resolve => { finish = resolve; }); } };
  const h = harness({ rpc }); h.flush();
  const job = h.control.load(h.disclosure); await new Promise(setImmediate);
  assert.equal(calls, 1); h.control.cleanup(); finish();
  assert.equal(await job, false); assert.equal(calls, 1); assert.equal(h.failures.length, 0);
});
