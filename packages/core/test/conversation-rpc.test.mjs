import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeConversationRpc } from '../src/renderer.mjs';

function fixture() {
  const rpc = { getLatestTurnId() {}, getTurnById() {} }, registry = { forHost: host => { assert.equal(host, 'local'); return rpc; } };
  const signal = { scope: { id: 'scope' }, resolve: () => 'atom' };
  const chain = new Map([['scope', { store: { get: () => registry } }]]);
  const root = { __reactContainer$fixture: { stateNode: { current: { memoizedProps: { value: chain } } } } };
  return { rpc, signal, document: { getElementById: id => id === 'root' ? root : null } };
}

test('Rspack conversation RPC discovery does not depend on unread or badge interfaces', async () => {
  const view = fixture(), calls = [];
  const assets = { find: async name => { calls.push(name); return { url: 'app://fixture#registry', load: () => ({ signal: view.signal }) }; } };
  const host = await loadNativeConversationRpc(view.document, { assets });
  assert.equal(host.forHost('local'), view.rpc);
  assert.deepEqual(calls, ['conversation RPC registry']);
});

test('ESM RPC discovery follows the native accessor rather than a minified export name', async () => {
  const view = fixture();
  const assets = { find: async () => null, resolve: async prefix => prefix === 'app-initial' ? 'app://fixture/initial.js' : null,
    read: async () => 'function accessor(){let a=1,b=c.get(signal);if(b!=null)return b;throw new Error("AppServerManager RPC is unavailable for hostId:")}export{signal as x}' };
  const host = await loadNativeConversationRpc(view.document, { assets, importModule: async () => ({ x: view.signal }) });
  assert.equal(host.forHost('local'), view.rpc);
  assert.equal(host.moduleUrl, 'app://fixture/initial.js');
});

test('RPC loader retains an original module failure and reports an unknown registry', async () => {
  const view = fixture(), original = new TypeError('native registry import failed');
  await assert.rejects(loadNativeConversationRpc(view.document, { assets: { find: async () => { throw original; } } }), error => error === original);
  await assert.rejects(loadNativeConversationRpc(view.document, { assets: { find: async () => ({ url: 'app://fixture', load: () => ({}) }) } }), /registry export changed/);
});
