import test from 'node:test';
import assert from 'node:assert/strict';
import { featureDom } from '../../core/test/support/feature-dom.mjs';
import { installChatRenderer } from '../src/renderer.mjs';
import { createNativeAssetReader } from '../../core/src/renderer.mjs';

test('renderer recovery retries failed native initialization while retaining healthy services and the same epoch', async () => {
  const { document } = featureDom(), window = document.defaultView;
  document.scripts = [{ type: 'module', src: 'app://-/assets/main.fixture.js' }];
  window.top = window; window.__CDTK_CHAT_BRIDGE__ = () => {};
  let fail = true, rpcCalls = 0, formatterCalls = 0, imports = 0;
  const require = () => ({ forHost: () => ({}) }); require.m = { rpc: function rpc() { return 'RPC fixture'; } }; require.c = {};
  const helpers = { chatCss: () => '', createNativeAssetReader: document => createNativeAssetReader(document, { importModule: async () => { imports++; if (fail) throw new Error('Original RPC failure'); return { __webpack_require__: require }; } }), readNativeConversationIdentity: () => null,
    createNativeBridgeClient: () => ({ close() {} }),
    loadNativeConversationRpc: async (_document, { assets }) => { rpcCalls++; return (await assets.find('RPC', source => source.includes('RPC fixture'))).load(); },
    loadNativeDurationFormatter: async () => { formatterCalls++; return value => String(value); } };
  installChatRenderer(window, { epoch: 'same', externalWeeklyUsage: true, externalKits: ['title-emoji', 'fast-mode-indicator', 'child-model-warning', 'selection-actions-delay', 'rich-paste-boundary', 'live-model-output', 'context-meter', 'output-speed', 'composer-timer', 'message-labels', 'history-show-all', 'file-line-highlight'] }, helpers);
  const renderer = window.__CODEX_DESKTOP_TOOLKIT_CHAT__;
  try {
    const first = await renderer.refresh(); assert.equal(first.errors[0].source, 'conversation-rpc');
    fail = false;
    const [recovered] = await Promise.all([renderer.recover(), renderer.recover()]);
    assert.deepEqual(recovered.errors, []); assert.equal(recovered.capabilities.rpc, true);
    assert.equal(window.__CODEX_DESKTOP_TOOLKIT_CHAT__, renderer); assert.equal(renderer.epoch, 'same');
    assert.equal(rpcCalls, 2); assert.equal(formatterCalls, 1); assert.equal(document.head.children.length, 1);
    assert.equal(imports, 2, 'the same real asset reader retries its previously rejected runtime lookup');
    await renderer.recover(); assert.equal(rpcCalls, 2); assert.equal(formatterCalls, 1);
  } finally { renderer.cleanup(); }
});
