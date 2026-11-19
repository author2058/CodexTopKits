import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createImageReferenceProxy } from '../src/image-reference-proxy.mjs';
import { createImageReferenceTransform } from '../src/image-reference-transform.mjs';
import { createTransformRouter } from '../src/transform-router.mjs';
import { zstdCompressSync, gzipSync } from 'node:zlib';
import WebSocket, { WebSocketServer } from 'ws';

test('HTTP and WebSocket keep native headers, body, status and message ordering', async () => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.version, 'fixture-native-version');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, authorization: req.headers.authorization, account: req.headers['chatgpt-account-id'], body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(418, { 'content-type': 'text/plain; charset=utf-8' }); res.end('原样响应');
  });
  const wsServer = new WebSocketServer({ server: upstream });
  wsServer.on('connection', (socket, req) => { assert.equal(req.headers.authorization, 'Bearer fixture'); assert.equal(req.headers.version, 'fixture-native-version'); socket.on('message', (body, binary) => socket.send(body, { binary })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const events = [];
  const proxy = await createImageReferenceProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, log: async event => events.push(event) });
  try {
    const response = await fetch(proxy.baseUrl + 'codex/responses', { method: 'POST', headers: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture-account', version: 'fixture-native-version' }, body: '请求原文' });
    assert.equal(response.status, 418); assert.equal(await response.text(), '原样响应');
    assert.deepEqual(received, [{ path: '/backend-api/codex/responses', authorization: 'Bearer fixture', account: 'fixture-account', body: '请求原文' }]);
    const socket = new WebSocket(proxy.baseUrl.replace('http:', 'ws:') + 'codex/responses', { headers: { authorization: 'Bearer fixture', version: 'fixture-native-version' } });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const messages = [];
    const done = new Promise(resolve => socket.on('message', (data, binary) => { messages.push({ text: data.toString('utf8'), binary }); if (messages.length === 2) resolve(); }));
    socket.send('第一条'); socket.send(Buffer.from([1, 2, 3])); await done;
    assert.deepEqual(messages, [{ text: '第一条', binary: false }, { text: '\x01\x02\x03', binary: true }]);
    socket.close();
    assert.ok(events.some(event => event.event === 'websocket-send'));
    assert.ok(events.some(event => event.event === 'http-send' && event.nativeVersion === 'fixture-native-version'));
    assert.ok(events.some(event => event.event === 'websocket-send' && event.nativeVersion === 'fixture-native-version'));
    assert.ok(!JSON.stringify(events).includes('Bearer fixture'));
    const denied = await fetch(proxy.baseUrl.replace(/\/[a-f0-9]{48}\//, '/wrong/') + 'codex/responses');
    assert.equal(denied.status, 400);
  } finally { await proxy.close(); wsServer.close(); await new Promise(resolve => upstream.close(resolve)); }
});

test('a backend update keeps an existing WebSocket open', async () => {
  const upstream = http.createServer(), wsServer = new WebSocketServer({ server: upstream });
  wsServer.on('connection', socket => socket.on('message', data => socket.send(data)));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const router = createTransformRouter(async data => Buffer.from('old:' + data)), proxy = await createImageReferenceProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, transform: (data, context) => router.apply(data, context) });
  try {
    const socket = new WebSocket(proxy.baseUrl.replace('http:', 'ws:') + 'codex/responses'); await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const exchange = text => new Promise(resolve => { socket.once('message', data => resolve(data.toString())); socket.send(text); });
    assert.equal(await exchange('first'), 'old:first'); await router.replace(async () => async data => Buffer.from('new:' + data));
    assert.equal(socket.readyState, WebSocket.OPEN); assert.equal(await exchange('second'), 'new:second'); socket.close();
  } finally { await proxy.close(); wsServer.close(); await new Promise(resolve => upstream.close(resolve)); }
});

test('HTTP-only experiment requests the documented native fallback without contacting upstream', async () => {
  const events = [];
  const proxy = await createImageReferenceProxy({ httpOnly: true, log: async event => events.push(event) });
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(proxy.baseUrl + 'codex/responses', { headers: { connection: 'Upgrade', upgrade: 'websocket' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 426);
    assert.ok(events.some(event => event.event === 'http-test-fallback' && event.status === 426));
  } finally { await proxy.close(); }
});

test('closing an HTTP caller cancels conversion and never sends a later model request', async () => {
  let enter, release, cancelled, hits = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const upstream = http.createServer((_req, res) => { hits++; res.end(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let signal;
  const proxy = await createImageReferenceProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, transform: async (data, context) => {
    signal = context.signal; cancelled = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); enter(); await gate; return data;
  } });
  try {
    const request = http.request(proxy.baseUrl + 'codex/responses', { method: 'POST' });
    request.on('error', error => { assert.equal(error.code, 'ECONNRESET'); });
    request.end('fixture'); await entered; request.destroy(); await cancelled;
    assert.equal(signal.aborted, true); release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hits, 0);
  } finally { release(); await proxy.close(); await new Promise(resolve => upstream.close(resolve)); }
});

test('HTTP meters compressed request and response bodies separately from logical JSON, including non-200 status', async () => {
  const raw = Buffer.from(JSON.stringify({ model: 'fixture-model', input: [{ type: 'message', content: [{ type: 'input_text', text: 'PRIVATE TEXT'.repeat(1000) }] }] }), 'utf8');
  const input = zstdCompressSync(raw), reply = gzipSync(Buffer.from('返回内容'.repeat(2000), 'utf8'));
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers['content-encoding'], 'zstd');
    assert.deepEqual(Buffer.concat(chunks), input);
    res.writeHead(429, { 'content-encoding': 'gzip' }); res.end(reply);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const events = [], transform = await createImageReferenceTransform();
  const proxy = await createImageReferenceProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, transform, log: async event => events.push(event) });
  try {
    const response = await fetch(proxy.baseUrl + 'codex/responses', { method: 'POST', headers: { 'thread-id': 'http-thread', 'x-client-request-id': 'request-one', 'content-encoding': 'zstd' }, body: input });
    assert.equal(response.status, 429); assert.equal(await response.text(), '返回内容'.repeat(2000));
    const record = events.filter(event => event.event === 'model-traffic').at(-1).record;
    assert.equal(record.threadId, 'http-thread'); assert.equal(record.nativeRequestId, 'request-one');
    assert.equal(record.up, input.length); assert.equal(record.down, reply.length);
    assert.equal(record.logicalBefore, raw.length); assert.equal(record.logicalAfter, raw.length);
    assert.equal(record.status, 429); assert.equal(record.complete, true);
    assert.ok(!JSON.stringify(events).includes('PRIVATE TEXT'));
  } finally { await proxy.close(); await new Promise(resolve => upstream.close(resolve)); }
});
