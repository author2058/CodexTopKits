import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { kitModule } from 'codex-toolkit-core/kits';
import composer from '../kits/agent-composer/index.mjs';
import protection from '../kits/agent-model-protection/index.mjs';

test('management language changes retain state, nodes and native connection', async () => {
  const page = await fs.readFile(new URL('../assets/session-manager.html', import.meta.url), 'utf8');
  assert.match(page, /<script src="\.\.\/\.\.\/management-localization\.js"><\/script>/);
  const script = page.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const ids = ['status', 'errors', 'error-heading', 'error-list', 'thread-table', 'no-threads', 'thread-rows', 'composer', 'check'];
  const nodes = Object.fromEntries(ids.map(id => [id, { textContent: '', innerHTML: '', hidden: false, addEventListener() {} }]));
  const fallback = { textContent: '' }; let locale = 'en', change, streams = 0, stream;
  const state = { revision: 1, errors: [{ message: '<native error>' }], registry: { threads: { child: { protected: true, settings: { model: 'test', effort: null, serviceTier: null } } } }, restoreAgentComposer: true, windows: [{ applicable: true }] };
  const document = { hidden: false, getElementById: id => nodes[id], querySelectorAll: () => [fallback], addEventListener() {} };
  const window = { addEventListener() {}, createCodexTopKitsManagementI18n({ messages, onChange }) { change = onChange; return { t(key, values = {}) { return messages[locale][key].replace(/\{(\w+)\}/g, (_, name) => values[name]); } }; } };
  class EventSource { constructor() { streams++; stream = this; } close() {} }
  const context = vm.createContext({ document, window, EventSource, fetch: async () => ({ ok: true, json: async () => state }) });
  new vm.Script(script).runInContext(context); await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.status.textContent, 'Found 1 issue(s)');
  assert.match(nodes['error-list'].innerHTML, /&lt;native error&gt;/);
  const rows = nodes['thread-rows'].innerHTML;
  locale = 'zh-Hans'; change();
  assert.equal(nodes.status.textContent, '发现 1 个问题'); assert.equal(fallback.textContent, '原生默认');
  assert.equal(nodes['thread-rows'].innerHTML, rows); assert.equal(streams, 1);
  stream.onerror(); locale = 'en'; change();
  assert.equal(nodes.status.textContent, 'Connection lost; reopen the management page to see its status.');
  assert.equal(streams, 1);
});

test('serialized Kit restart preflight uses the current locale without changing protection', () => {
  for (const definition of [composer, protection]) {
    const serialized = new vm.Script(kitModule(definition).replace(/^export default /, '')).runInNewContext();
    let locale = 'en';
    const panel = { closest: () => null, querySelector: () => ({}) };
    const view = { location: { pathname: '/' }, MutationObserver: class { observe() {} disconnect() {} }, addEventListener() {}, removeEventListener() {}, queueMicrotask() {}, __CODEX_DESKTOP_TOOLKIT_SESSION__: { handoffs: { agentComposer: true, modelProtection: true }, getRegistry: () => ({}) } };
    const document = { defaultView: view, documentElement: {}, querySelectorAll: selector => selector.startsWith('main.') ? [panel] : [] };
    const context = { document, restartPreflight: true, serviceVersionChecks: true, onDomChange: () => () => {}, reportError() {}, i18n: { t: (messages, key) => messages[locale][key] } };
    const helpers = { createNativeBridgeClient: () => ({ close() {} }), createNativeAssetReader: () => ({}), installAgentComposerRestore: () => ({ refresh() {}, status: () => ({ active: true }), cleanup() {} }), createRuntimeGuard: () => ({ busy: () => true, cleanup() {}, update() {} }) };
    const kit = serialized.create(context, helpers);
    assert.throws(() => kit.beforeRestart(), /being/);
    locale = 'zh-Hans'; assert.throws(() => kit.beforeRestart(), /子代理/);
  }
});
