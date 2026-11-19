import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { kitModule } from 'codex-toolkit-core/kits';
import history from '../kits/history-show-all/index.mjs';
import fast from '../kits/fast-mode-indicator/index.mjs';

test('management locale changes retain native state, diagnostics and connection', async () => {
  const page = await fs.readFile(new URL('../assets/chat-manager.html', import.meta.url), 'utf8');
  assert.match(page, /<script src="\.\.\/\.\.\/management-localization\.js"><\/script>/);
  const script = page.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const nodes = Object.fromEntries(['status', 'errors', 'windows', 'check'].map(id => [id, { textContent: '', innerHTML: '', hidden: false, addEventListener() {} }]));
  const issue = { dataset: { chatText: 'issues' }, textContent: '' }, thread = { dataset: { chatText: 'thread' }, textContent: '' };
  let locale = 'en', change, stream, streams = 0, fetches = 0;
  const state = { revision: 1, errors: [{ message: '<native error>' }], windows: [{ applicable: true, threadId: 'native title', capabilities: { rpc: true, formatter: true, usage: false, speedPanels: [1] } }] };
  const document = { hidden: false, getElementById: id => nodes[id], querySelectorAll: () => [issue, thread], addEventListener() {} };
  const window = { addEventListener() {}, createCodexTopKitsManagementI18n({ messages, onChange }) { change = onChange; return { t(key, values = {}) { return messages[locale][key].replace(/\{(\w+)\}/g, (_, name) => values[name]); } }; } };
  class EventSource { constructor() { streams++; stream = this; } close() {} }
  const context = vm.createContext({ document, window, EventSource, fetch: async () => { fetches++; return { ok: true, json: async () => state }; } });
  new vm.Script(script).runInContext(context); await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.status.textContent, 'Issues found: 1'); assert.match(nodes.errors.innerHTML, /&lt;native error&gt;/);
  const windows = nodes.windows.innerHTML, errors = nodes.errors.innerHTML;
  locale = 'zh-Hans'; change(); assert.equal(nodes.status.textContent, '发现 1 个问题'); assert.equal(issue.textContent, '聊天增强发现 1 个问题');
  assert.equal(thread.textContent, '会话'); assert.equal(nodes.windows.innerHTML, windows); assert.equal(nodes.errors.innerHTML, errors); assert.equal(fetches, 1); assert.equal(streams, 1);
  stream.onerror(); locale = 'en'; change(); assert.match(nodes.status.textContent, /^Connection interrupted/); assert.equal(fetches, 1); assert.equal(streams, 1);
});

test('serialized history and fast Kits subscribe once and release locale listeners', () => {
  for (const definition of [history, fast]) {
    const serialized = new vm.Script(kitModule(definition).replace(/^export default /, '')).runInNewContext();
    let locale = 'en', changed, updates = 0, cleaned = 0;
    const view = { location: { pathname: '/' }, MutationObserver: class { observe() {} disconnect() {} }, addEventListener() {}, removeEventListener() {} };
    const main = { isConnected: true, matches: () => true, closest: () => null };
    const document = { defaultView: view, documentElement: {}, head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, remove() {} }), querySelectorAll: selector => selector.startsWith('main.') ? [main] : [] };
    const context = { document, onDomChange: () => () => {}, reportError() {}, i18n: { t: (messages, key) => messages[locale][key], onChange(callback) { changed = callback; return () => { cleaned++; }; } } };
    const control = { updateText() { updates++; }, refresh() {}, cleanup() {} };
    const helpers = { ...serialized.helpers, createNativeBridgeClient: () => ({ close() {} }), readNativeConversationIdentity: () => null,
      installModelDecorations: () => control, installTurnHistoryControl: () => control, loadNativeConversationRpc: () => new Promise(() => {}), createNativeAssetReader: () => ({}) };
    const instance = serialized.create(context, helpers); locale = 'zh-Hans'; changed(); assert.equal(updates, 1); instance.close(); assert.equal(cleaned, 1);
  }
});
