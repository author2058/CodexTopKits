import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ModelTrafficMeter, meterWebSocket } from '../src/model-traffic.mjs';
import { TrafficLog } from '../src/traffic-log.mjs';

import WebSocket, { WebSocketServer } from 'ws';

test('compressed WebSocket counters match independent TCP byte deltas, not decoded text length', async () => {
  const server = http.createServer(), wss = new WebSocketServer({ server, perMessageDeflate: true });
  let peer, before;
  wss.on('connection', socket => {
    peer = socket; before = { up: socket._socket.bytesRead, down: socket._socket.bytesWritten };
    socket.on('message', data => socket.send(data, { compress: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { perMessageDeflate: true });
  const events = [], meter = new ModelTrafficMeter({ headers: { 'thread-id': 'thread-one', authorization: 'PRIVATE' }, endpoint: 'wss://example.test/responses', transport: 'websocket', log: async event => events.push(event) });
  try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    assert.equal(meterWebSocket(socket, meter), true);
    const text = '中文原始模型请求'.repeat(10000);
    const reply = new Promise(resolve => socket.once('message', data => resolve(data.toString('utf8'))));
    socket.send(text, { compress: true });
    assert.equal(await reply, text);
    meter.finish(true);
    const record = events.at(-1).record;
    assert.ok(record.up > 0 && record.up < Buffer.byteLength(text) / 10);
    assert.equal(record.up, peer._socket.bytesRead - before.up);
    assert.equal(record.down, peer._socket.bytesWritten - before.down);
    assert.equal(record.threadId, 'thread-one');
    assert.ok(!JSON.stringify(events).includes('PRIVATE'));
  } finally { socket.terminate(); for (const peer of wss.clients) peer.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); }
});

test('missing private metering interface is visible and never closes or sends on the model socket', () => {
  const meter = new ModelTrafficMeter({ transport: 'websocket', endpoint: 'wss://example.test/responses' });
  assert.equal(meterWebSocket({}, meter), false);
  assert.equal(meter.record.measurementError, 'websocket-frame-interface-unavailable');
  meter.finish(false);
});

test('a shared upload finishing after caller cancellation remains counted under its initiating thread', () => {
  const events = [], meter = new ModelTrafficMeter({ headers: { 'thread-id': 'cancelled-owner' }, transport: 'http', endpoint: 'https://example.test/responses', log: async event => events.push(event) });
  meter.finish(false, new DOMException('cancelled', 'AbortError'));
  meter.add('imageUploadBytes', 1234);
  assert.equal(events.at(-1).record.imageUploadBytes, 1234);
  assert.equal(events.at(-1).record.threadId, 'cancelled-owner');
  assert.equal(events.at(-1).record.complete, false);
});

test('snapshots import idempotently by revision and interval deltas, preserving unassigned traffic', () => {
  const log = new TrafficLog(':memory:');
  const meter = new ModelTrafficMeter({ headers: { 'thread-id': 'thread-one' }, endpoint: 'https://example.test/responses', transport: 'http' });
  const first = { ...meter.record, started: 60000, updated: 61000, revision: 1, up: 100, down: 10 };
  const second = { ...first, updated: 121000, revision: 2, up: 170, down: 30 };
  log.model(first); log.model(first); log.model(second); log.model(first);
  const recent = log.query({ from: 120000, to: 130000 });
  assert.equal(recent.modelThreads[0].up, 70); assert.equal(recent.modelThreads[0].down, 20);
  assert.equal(log.query({ from: 0, to: 130000 }).modelThreads[0].up, 170);
  meter.identify({ thread_id: 'thread-two' });
  assert.equal(meter.record.threadId, null);
  log.model({ ...second, updated: 122000, revision: 3, threadId: null, attributionError: meter.record.attributionError });
  assert.equal(log.query({ from: 0, to: 130000 }).modelThreads[0].threadId, null);
  assert.throws(() => log.model({ ...second, revision: 4, up: 1 }), /backwards/);
  log.close();
});
