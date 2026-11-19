import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeBridgeClient } from '../src/renderer.mjs';

function fixture(send) {
  const window = new EventTarget(), requests = [], listeners = new Set();
  window.crypto = crypto;
  const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
  window.addEventListener = (type, listener) => { listeners.add(listener); add(type, listener); };
  window.removeEventListener = (type, listener) => { listeners.delete(listener); remove(type, listener); };
  window.electronBridge = { sendMessageFromView(message) { requests.push(message); return send?.(message); } };
  const client = createNativeBridgeClient(window);
  const reply = (data, source = null) => window.dispatchEvent(new MessageEvent('message', { data, source }));
  return { client, window, requests, listeners, reply };
}

test('concurrent requests share a listener, accept native source=null, and stop listening when idle', async () => {
  const f = fixture();
  const one = f.client.request({}, 'fetch-response', 'one'), two = f.client.request({}, 'mcp-response', 'two');
  assert.equal(f.listeners.size, 1);
  f.reply({ type: 'mcp-response', message: { id: 'unrelated', result: 0 } });
  f.reply({ type: 'mcp-response', message: { id: 'two', result: 2 } });
  assert.equal((await two).message.result, 2); assert.equal(f.listeners.size, 1);
  f.reply({ type: 'fetch-response', requestId: 'one', status: 200 });
  assert.equal((await one).status, 200); assert.equal(f.listeners.size, 0); f.client.close();
});

test('closing rejects only owned pending work and cancels its timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), pending = f.client.appServer('thread/read', { threadId: 'one' });
  f.client.close(); await assert.rejects(pending, /stopped/); assert.equal(f.listeners.size, 0); t.mock.timers.tick(5000);
});

test('bridge failures retain original identity and remote error details', async () => {
  const original = new TypeError('preload send failed'), first = fixture(async () => { throw original; });
  await assert.rejects(first.client.request({}, 'mcp-response', 'one'), error => error === original);
  assert.equal(first.listeners.size, 0);
  const second = fixture(), pending = second.client.appServer('thread/read', {}), remote = { code: 429, message: 'native rejected', data: { retry: false } };
  second.reply({ type: 'mcp-response', message: { id: second.requests[0].request.id, error: remote } });
  await assert.rejects(pending, error => error.code === 429 && error.message === remote.message && error.cause.code === 429 && error.data.retry === false);
});

test('unknown response shapes fail at their boundary rather than turning into timeouts', async () => {
  const f = fixture(), pending = f.client.appServer('thread/read', {});
  f.reply({ type: 'mcp-response', message: { id: f.requests[0].request.id } });
  await assert.rejects(pending, /no result/);
  const wrong = f.client.request({}, 'fetch-response', 'wrong'); f.reply({ type: 'changed-protocol', requestId: 'wrong' });
  await assert.rejects(wrong, /response type changed/); assert.equal(f.listeners.size, 0);
});
