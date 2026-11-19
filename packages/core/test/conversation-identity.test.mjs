import test from 'node:test';
import assert from 'node:assert/strict';
import { readNativeConversationIdentity } from '../src/renderer.mjs';

function fixture({ value = 'thread', host, activeKey, seedHost, hiddenOld = false, routeId = 'thread' } = {}) {
  const workspace = { getClientRects: () => [{}] };
  const annotation = {
    closest: selector => selector === '[role="tabpanel"]' ? null : workspace,
    getAttribute: () => value,
    __reactFiber$fixture: { memoizedProps: { value: { location: { pathname: '/local/' + routeId, search: host ? '?hostId=' + encodeURIComponent(host) : '' } } } },
  };
  const active = activeKey ? { getAttribute: () => activeKey } : null;
  return {
    defaultView: { getComputedStyle: () => ({ visibility: 'visible' }),
      electronBridge: { getInitialSidebarBootstrap: () => ({ catalogEntries: seedHost ? [{ threadId: 'thread', hostId: seedHost }] : [] }) } },
    querySelector: () => active,
    querySelectorAll: () => hiddenOld ? [
      { closest: selector => selector === '[role="tabpanel"]' ? null : { getClientRects: () => [] }, getAttribute: () => 'old' }, annotation,
    ] : [annotation],
  };
}

test('the visible native conversation owns its host, including a closed sidebar and colon-bearing host IDs', () => {
  for (const host of ['local', 'durable', 'remote-control:env_test']) {
    const result = readNativeConversationIdentity(fixture({ host, hiddenOld: true }));
    assert.equal(result.hostId, host);
    assert.equal(result.taskKey, host + ':thread');
  }
});

test('explicit keys stay authoritative and unrelated outer routes do not supply a host', () => {
  assert.equal(readNativeConversationIdentity(fixture({ value: 'remote-control:env_test:thread', host: 'durable' })).hostId, 'remote-control:env_test');
  assert.equal(readNativeConversationIdentity(fixture({ host: 'durable', routeId: 'other', activeKey: 'local:thread' })).hostId, 'local');
  assert.equal(readNativeConversationIdentity(fixture({ host: 'durable', routeId: 'other', seedHost: 'remote-control:env_test' })).hostId, 'remote-control:env_test');
  assert.equal(readNativeConversationIdentity(fixture({ value: null })), null);
});

test('a Dot route cannot inherit a stale selected local sidebar thread', () => {
  const document = fixture({ activeKey: 'local:old' });
  const main = { getClientRects: () => [{}], __reactFiber$fixture: { memoizedProps: { value: { location: { pathname: '/dots/cloud' } } } } };
  document.querySelectorAll = selector => selector.startsWith('main') ? [main] : [];
  assert.equal(readNativeConversationIdentity(document), null);
});
