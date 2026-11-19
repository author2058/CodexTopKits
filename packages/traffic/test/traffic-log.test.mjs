import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficEndpoint, trafficCategory, trafficContent, TrafficLog, recordNetlog, TrafficRecorder } from '../src/traffic-log.mjs';

test('native recording coverage follows the configured directory without claiming measured wire bytes', async t => {
  const previous = process.env.CODEX_ROLLOUT_TRACE_ROOT;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_ROLLOUT_TRACE_ROOT;
    else process.env.CODEX_ROLLOUT_TRACE_ROOT = previous;
  });
  delete process.env.CODEX_ROLLOUT_TRACE_ROOT;
  const disabled = new TrafficRecorder({ filename: ':memory:', port: 12345 });
  assert.match(disabled.query().coverage.find(row => row.id === 'native-content').message, /未配置/);
  await disabled.close();
  process.env.CODEX_ROLLOUT_TRACE_ROOT = '/synthetic/native-trace';
  const configured = new TrafficRecorder({ filename: ':memory:', port: 12345 });
  const message = configured.query().coverage.find(row => row.id === 'native-content').message;
  assert.match(message, /\/synthetic\/native-trace/);
  assert.match(message, /正文大小不是网络字节数/);
  await configured.close();
});

test('classifies actual routes, including images embedded in model requests, not query guesses', () => {
  assert.equal(trafficCategory('https://chatgpt.com/backend-api/codex/responses?key=secret'), 'model');
  assert.equal(trafficCategory('https://chat.openai.com/ces/v1/telemetry/intake?secret=1'), 'telemetry');
  assert.equal(trafficCategory('wss://chatgpt.com/backend-api/pubsub'), 'realtime');
  assert.equal(trafficCategory('https://example.org/?path=/responses'), 'external');
  assert.equal(trafficCategory('http://127.0.0.1:13233/api/state'), 'local');
  assert.equal(trafficEndpoint('data:image/png;base64,abc'), null);
  assert.equal(trafficEndpoint('https://chatgpt.com/a?token=private#other'), 'https://chatgpt.com/a');
});

test('counts base64 bytes separately from decoded image bytes and never retains content', () => {
  const body = JSON.stringify({ model: 'test-model', input: [{ type: 'input_text', text: 'PRIVATE PROMPT' },
    { type: 'input_image', image_url: 'data:image/webp;base64,AQIDBA==' },
    { type: 'input_image', image_url: 'https://example.org/private-image' }] });
  const result = trafficContent(body);
  assert.equal(result.imageCount, 1); assert.equal(result.imageBase64Bytes, 8); assert.equal(result.imageBinaryBytes, 4);
  assert.equal(result.jsonBytes, Buffer.byteLength(body)); assert.equal(result.linkedImages, 1);
  assert.equal(result.model, 'test-model');
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok(!JSON.stringify(result).includes('AQID'));
  assert.equal(trafficContent('null').format, 'json');
  assert.equal(trafficContent('binary or partial {').format, 'non-json-or-incomplete');
});

test('records actual HTTP2 DATA, partial sends, errors, separate socket layers, and unattributed streams', () => {
  const log = new TrafficLog(':memory:');
  const event = (name, params, ts, id = '0x1') => ({ name, args: { params }, ts, pid: 123, cat: 'netlog', id2: { local: id } });
  const events = [
    { name: 'clock_sync', ts: 1000000, args: { sync_id: 'cdt:60000' } },
    event('HTTP2_SESSION_SEND_HEADERS', { stream_id: 1, headers: [':authority: chatgpt.com', ':path: /ces/v1/rgstr?token=SECRET', ':method: POST', 'content-length: 200000', 'cookie: PRIVATE'] }, 1001000),
    event('HTTP2_SESSION_SEND_DATA', { stream_id: 1, size: 3000 }, 1002000),
    event('HTTP2_SESSION_RECV_DATA', { stream_id: 1, size: 13 }, 1003000),
    event('HTTP2_SESSION_RECV_HEADERS', { stream_id: 1, headers: [':status: 403'] }, 1004000),
    event('HTTP2_SESSION_SEND_RST_STREAM', { stream_id: 1, error_code: 8 }, 1005000),
    event('HTTP2_SESSION_SEND_DATA', { stream_id: 9, size: 400 }, 1006000),
    event('SSL_SOCKET_BYTES_SENT', { byte_count: 3450 }, 1007000),
    event('SOCKET_BYTES_SENT', { byte_count: 3500 }, 1008000),
  ];
  const result = recordNetlog(log, events, { id: 'test', started: 60000, ended: 61000 });
  assert.equal(result.clock, 'clock-sync');
  const snapshot = log.query({ from: 60000, to: 62000 });
  const record = snapshot.requests[0];
  assert.equal(record.up, 3000); assert.equal(record.down, 13); assert.equal(record.status, 403);
  assert.equal(record.details.reset.code, 8); assert.equal(record.details.declaredContentLength, '200000');
  assert.equal(record.endpoint, 'https://chatgpt.com/ces/v1/rgstr');
  assert.ok(!JSON.stringify(snapshot).includes('SECRET')); assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
  assert.deepEqual(snapshot.totals.map(row => [row.layer, row.category, row.up]).sort(), [
    ['http2-data', 'telemetry', 3000], ['http2-data', 'unattributed', 400],
    ['socket-plaintext', 'all-chromium', 3450], ['socket-transport', 'all-chromium', 3500],
  ].sort());
  assert.equal(log.query({ from: 60001, to: 62000, category: 'telemetry' }).totals[0].up, 3000);
  log.close();
});

test('retries are counted as separate requests and actual data accumulates, not declared length', () => {
  const log = new TrafficLog(':memory:');
  const events = [1, 3].flatMap(stream_id => [
    { name: 'HTTP2_SESSION_SEND_HEADERS', cat: 'netlog', pid: 1, id2: { local: '1' }, ts: 1,
      args: { params: { stream_id, headers: [':authority: chatgpt.com', ':path: /backend-api/codex/responses', ':method: POST'] } } },
    { name: 'HTTP2_SESSION_SEND_DATA', cat: 'netlog', pid: 1, id2: { local: '1' }, ts: 2, args: { params: { stream_id, size: 17 } } },
  ]);
  recordNetlog(log, events, { started: 60000, ended: 60001 });
  const result = log.query({ from: 0, to: 70000 });
  assert.equal(result.requests.length, 2); assert.equal(result.totals[0].up, 34);
  log.close();
});

test('unexpected protocol data fails visibly and rolls back the batch', () => {
  const log = new TrafficLog(':memory:');
  assert.throws(() => recordNetlog(log, [{ name: 'HTTP2_SESSION_SEND_DATA', cat: 'netlog', ts: 1, args: { params: {} } }]), /valid size/);
  assert.equal(log.query().totals.length, 0);
  assert.throws(() => log.bytes(Date.now(), 'test', 'test', '', 0, -1, 0), /Invalid/);
  assert.throws(() => log.query({ from: NaN }), /Invalid traffic time/);
  log.close();
});

test('connection snapshots preserve first seen and update last seen without inventing bytes', () => {
  const log = new TrafficLog(':memory:');
  const row = { pid: 1, process: 'codex.exe', protocol: 'TCP4', local: '127.0.0.1:1', remote: '198.18.0.1:443', state: 'Established' };
  log.connections([row], 60000); log.connections([row], 120000);
  const result = log.query({ from: 0, to: 180000 });
  assert.equal(result.connections[0].firstSeen, 60000); assert.equal(result.connections[0].lastSeen, 120000);
  assert.equal(result.totals.length, 0); log.close();
});

test('anonymous unresponsive workers do not block collection, and webviews are included', async () => {
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345 });
  const calls = [];
  recorder.client = { socket: { readyState: WebSocket.CLOSED }, close() {}, send: async method => { calls.push(method); return { sessionId: 'test-session' }; } };
  await recorder.attach({ targetId: 'anonymous-worker', type: 'worker', url: '' });
  assert.deepEqual(calls, []); assert.equal(recorder.unresolvedWorkers.size, 1);
  await recorder.attach({ targetId: 'browser', type: 'webview', url: 'https://example.org/' });
  assert.deepEqual(calls, ['Target.attachToTarget', 'Network.enable']);
  assert.equal(recorder.sessions.get('test-session'), 'browser');
  await recorder.close();
});

test('page payload composition never becomes a fabricated transmitted-byte count', async () => {
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345 });
  recorder.sessions.set('s1', 'window1');
  await recorder.receive({ sessionId: 's1', method: 'Network.requestWillBeSent', params: { requestId: 'request1',
    timestamp: 1, wallTime: Date.now() / 1000, type: 'Fetch', initiator: { type: 'script' },
    request: { url: 'https://chatgpt.com/backend-api/codex/responses?secret=123', method: 'POST',
      postData: '{"input":[{"image_url":"data:image/webp;base64,AQID"}],"text":"PRIVATE"}' } } });
  await recorder.receive({ sessionId: 's1', method: 'Network.loadingFinished', params: { requestId: 'request1', encodedDataLength: 55 } });
  const result = recorder.query();
  assert.equal(result.requests[0].details.content.imageBinaryBytes, 3);
  assert.equal(result.requests[0].up, null); assert.equal(result.requests[0].down, null);
  assert.equal(result.requests[0].details.encodedResponseBytes, 55);
  assert.equal(result.totals.length, 0); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  await recorder.close();
});

test('a destroyed target retires only its own error from coverage and current health', async () => {
  const errors = new Map(), recorder = new TrafficRecorder({ filename: ':memory:', port: 12345,
    onError: (error, id) => errors.set(id, error), onRecovered: id => errors.delete(id) });
  try {
    recorder.failure('page-target:closed', new Error('Original closed-page timeout'));
    recorder.failure('page-target:live', new TypeError('Unrelated live-page failure'));
    recorder.attached.add('closed');
    await recorder.receive({ method: 'Target.targetDestroyed', params: { targetId: 'closed' } });
    assert.equal(recorder.attached.has('closed'), false);
    assert.deepEqual([...errors.keys()], ['page-target:live']);
    const coverage = recorder.query().coverage;
    assert.equal(coverage.find(row => row.id === 'page-target:closed').status, 'info');
    assert.equal(coverage.find(row => row.id === 'page-target:live').status, 'error');
    recorder.log.coverage('chromium', 'paused', 'Manual pause'); recorder.recovered('chromium');
    assert.equal(recorder.query().coverage.find(row => row.id === 'chromium').status, 'paused');
  } finally { await recorder.close(); }
});

test('a timed-out owned start ends and flushes its own session before retrying once', async () => {
  const errors = new Map(), calls = [], timeout = Object.assign(new Error('Original start timeout'), { code: 'CDP_COMMAND_TIMEOUT' });
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345,
    onError: (error, id) => errors.set(id, error), onRecovered: id => errors.delete(id) });
  let starts = 0;
  recorder.client = { closed: false, traceState: 'uncertain', socket: { readyState: WebSocket.CLOSED }, close() {}, async send(method) {
    calls.push(method);
    if (method === 'Tracing.start' && ++starts === 1) throw timeout;
    if (method === 'Tracing.end') await recorder.receive({ method: 'Tracing.tracingComplete', params: {} });
    return {};
  } };
  try {
    await recorder.startTrace();
    assert.deepEqual(calls, ['Tracing.start', 'Tracing.end', 'Tracing.start', 'Tracing.recordClockSyncMarker']);
    assert.equal(recorder.tracing, true); assert.equal(errors.size, 0);
    assert.equal(recorder.query().coverage.find(row => row.id === 'chromium').status, 'active');
  } finally { recorder.tracing = false; await recorder.close(); }
});

test('an uncertain trace owner or unexpected error is not hidden or repeatedly retried', async () => {
  const errors = new Map(), calls = [], timeout = Object.assign(new Error('Original start timeout'), { code: 'CDP_COMMAND_TIMEOUT' });
  const busy = Object.assign(new Error('Tracing has already been started (possibly in another tab).'), { code: -32000 });
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345,
    onError: (error, id) => errors.set(id, error), onRecovered: id => errors.delete(id) });
  let starts = 0;
  recorder.client = { closed: false, socket: { readyState: WebSocket.CLOSED }, close() {}, async send(method) {
    calls.push(method);
    if (method === 'Tracing.start') throw ++starts === 1 ? timeout : busy;
    return {};
  } };
  try {
    await assert.rejects(recorder.startTrace(), error => error === timeout);
    assert.deepEqual(calls, ['Tracing.start']);
    assert.equal(errors.size, 0); assert.equal(recorder.tracing, false);
    calls.length = 0;
    const unexpected = new TypeError('Original invalid trace request');
    recorder.client.send = async method => { calls.push(method); throw unexpected; };
    await assert.rejects(recorder.startTrace(), error => error === unexpected);
    assert.deepEqual(calls, ['Tracing.start']);
  } finally { await recorder.close(); }
});

test('a pause during owned trace cleanup prevents another trace start', async () => {
  const calls = [], gate = Promise.withResolvers();
  const timeout = Object.assign(new Error('Original start timeout'), { code: 'CDP_COMMAND_TIMEOUT' });
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345, onError() {} });
  recorder.client = { closed: false, traceState: 'uncertain', socket: { readyState: WebSocket.CLOSED }, close() {}, async send(method) {
    calls.push(method);
    if (method === 'Tracing.start') throw timeout;
    if (method === 'Tracing.end') { await gate.promise; await recorder.receive({ method: 'Tracing.tracingComplete', params: {} }); }
    return {};
  } };
  try {
    const pending = recorder.startTrace();
    await new Promise(resolve => setImmediate(resolve));
    recorder.paused = true; gate.resolve({});
    await pending;
    assert.deepEqual(calls, ['Tracing.start', 'Tracing.end']);
  } finally { await recorder.close(); }
});

test('concurrent trace starts share one operation and closing waits for its acknowledged start', async () => {
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345 }), gate = Promise.withResolvers(), calls = [];
  recorder.client = { closed: false, socket: { readyState: WebSocket.OPEN }, async close() { this.closed = true; }, async send(method) {
    calls.push(method);
    if (method === 'Tracing.start') await gate.promise;
    if (method === 'Tracing.end') await recorder.receive({ method: 'Tracing.tracingComplete', params: {} });
    return {};
  } };
  const first = recorder.startTrace(), second = recorder.startTrace();
  assert.equal(first, second); assert.deepEqual(calls, ['Tracing.start']);
  const closing = recorder.close(); assert.equal(recorder.client.closed, false);
  gate.resolve(); await Promise.all([first, second, closing]);
  assert.deepEqual(calls, ['Tracing.start', 'Tracing.end']); assert.equal(recorder.client.closed, true);
  assert.equal(recorder.starting, null); assert.equal(recorder.tracing, false); assert.equal(recorder.timer, undefined);
});

test('an owned uncertain start with a negative end acknowledgement can release and retry', async () => {
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345, onError() {} }); let starts = 0;
  const timeout = Object.assign(new Error('Original start timeout'), { code: 'CDP_COMMAND_TIMEOUT' });
  recorder.client = { closed: false, traceState: 'uncertain', socket: { readyState: WebSocket.CLOSED }, close() {}, async send(method) {
    if (method === 'Tracing.start' && ++starts === 1) throw timeout;
    if (method === 'Tracing.end') throw Object.assign(new Error('Tracing is not started'), { code: -32000 });
    return {};
  } };
  try { await recorder.startTrace(); assert.equal(starts, 2); assert.equal(recorder.tracing, true); }
  finally { recorder.tracing = false; await recorder.close(); }
});

test('closing during an unacknowledged owned start cleans up without a retry or leftover timer', async () => {
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345 }), gate = Promise.withResolvers(), calls = [];
  recorder.client = { closed: false, traceState: 'uncertain', socket: { readyState: WebSocket.OPEN }, async close() { this.closed = true; }, async send(method) {
    calls.push(method);
    if (method === 'Tracing.start') { await gate.promise; throw Object.assign(new Error('Original start timeout'), { code: 'CDP_COMMAND_TIMEOUT' }); }
    if (method === 'Tracing.end') await recorder.receive({ method: 'Tracing.tracingComplete', params: {} });
    return {};
  } };
  const starting = recorder.startTrace(), closing = recorder.close();
  gate.resolve(); await Promise.all([starting, closing]);
  assert.deepEqual(calls, ['Tracing.start', 'Tracing.end']); assert.equal(recorder.client.closed, true);
  assert.equal(recorder.starting, null); assert.equal(recorder.tracing, false); assert.equal(recorder.timer, undefined);
});

test('a marker failure during rotation close drains rotation and ends the acknowledged trace before releasing its lease', async () => {
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345 }), entered = Promise.withResolvers(), marker = Promise.withResolvers();
  const original = new TypeError('Original clock marker failure'), calls = []; let active = true, rotationsFinished = false;
  recorder.tracing = true;
  recorder.client = { closed: false, socket: { readyState: WebSocket.OPEN }, async close() {
    calls.push('close'); assert.equal(active, false); assert.equal(rotationsFinished, true); this.closed = true;
  }, async send(method) {
    calls.push(method);
    if (method === 'Tracing.start') active = true;
    if (method === 'Tracing.recordClockSyncMarker') { entered.resolve(); await marker.promise; }
    if (method === 'Tracing.end') { active = false; await recorder.receive({ method: 'Tracing.tracingComplete', params: {} }); }
    return {};
  } };
  recorder.rotation = recorder.rotate().catch(error => { assert.equal(error, original); }).finally(() => { rotationsFinished = true; });
  await entered.promise;
  const closed = assert.rejects(recorder.close(), error => error === original);
  marker.reject(original); await closed;
  assert.deepEqual(calls, ['Tracing.end', 'Tracing.start', 'Tracing.recordClockSyncMarker', 'Tracing.end', 'close']);
  assert.equal(recorder.client.closed, true); assert.equal(recorder.tracing, false); assert.equal(recorder.starting, null);
  assert.equal(recorder.timer, undefined);
});

test('rotation saves the completed segment even if starting the next segment fails', async () => {
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345 });
  const original = new Error('Next trace could not start');
  recorder.traceStarted = 60000;
  recorder.traceEvents = [{ name: 'SOCKET_BYTES_SENT', cat: 'netlog', ts: 1, pid: 123,
    args: { params: { byte_count: 42 } } }];
  recorder.endTrace = async () => {};
  recorder.startTrace = async () => { throw original; };
  try {
    await assert.rejects(recorder.rotate(), error => error === original);
    assert.equal(recorder.query().totals.find(row => row.layer === 'socket-transport').up, 42);
  } finally { await recorder.close(); }
});

test('manual flush and close cancel the previous capture timer', async () => {
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345 });
  let fired = false;
  recorder.timer = setTimeout(() => { fired = true; }, 5);
  recorder.endTrace = async () => {};
  recorder.startTrace = async () => {};
  await recorder.rotate(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(fired, false); await recorder.close();
});

test('pausing releases the owned trace, and enabling twice preserves its flush timer', async () => {
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 12345 });
  let starts = 0, ends = 0;
  recorder.startTrace = async () => { starts++; recorder.tracing = true; recorder.timer = setTimeout(() => {}, 1000); };
  recorder.endTrace = async () => { if (recorder.tracing) ends++; recorder.tracing = false; };
  await recorder.setTracing(true); const timer = recorder.timer;
  await recorder.setTracing(true); assert.equal(recorder.timer, timer); assert.equal(starts, 1);
  assert.deepEqual(await recorder.setTracing(false), { enabled: false }); assert.equal(ends, 1);
  assert.equal(recorder.query().coverage.find(x => x.id === 'chromium').status, 'paused');
  await recorder.close();
});

test('trace completion after the old 8-second limit clears ownership; concurrent endings share one command', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const events = [], recorder = new TrafficRecorder({ filename: ':memory:', port: 1, onDiagnostic: event => events.push(event) });
  let ends = 0;
  recorder.tracing = true; recorder.paused = true;
  recorder.client = { send: async (method, _params, _session, budget) => {
    assert.equal(method, 'Tracing.end'); assert.equal(budget, 60000); ends++;
  }, close() {}, socket: { readyState: WebSocket.CLOSED } };
  const first = recorder.endTrace(), second = recorder.endTrace();
  t.mock.timers.tick(9000);
  await recorder.receive({ method: 'Tracing.tracingComplete', params: {} });
  await Promise.all([first, second]);
  assert.equal(ends, 1); assert.equal(recorder.tracing, false);
  assert.equal(events.find(x => x.event === 'traffic-trace-end-settled').elapsedMs, 9000);
  await recorder.close();
});

test('trace timeout stays visible, and a late completion reconciles ownership', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const recorder = new TrafficRecorder({ filename: ':memory:', port: 1 });
  recorder.tracing = true; recorder.paused = true;
  recorder.client = { send: async () => {}, close() {}, socket: { readyState: WebSocket.CLOSED } };
  const ended = assert.rejects(recorder.endTrace(), /60 seconds/);
  t.mock.timers.tick(60000); await ended;
  assert.equal(recorder.tracing, true);
  await recorder.receive({ method: 'Tracing.tracingComplete' });
  assert.equal(recorder.tracing, false);
  await recorder.close();
});

test('interrupted shutdown saves available frames and marks the final capture incomplete', async () => {
  const log = new TrafficLog(':memory:'), recorder = new TrafficRecorder({ log, port: 1 });
  recorder.tracing = true;
  recorder.client = { closed: true, socket: { readyState: WebSocket.OPEN }, close() {} };
  recorder.traceStarted = 60000;
  recorder.traceEvents = [{ name: 'clock_sync', ts: 1000000, args: { sync_id: 'cdt:60000' } },
    { name: 'SSL_SOCKET_BYTES_SENT', cat: 'netlog', ts: 1001000, pid: 1, args: { params: { byte_count: 88 } } }];
  recorder.frames.set('fixture', { at: 60000, category: 'model', endpoint: 'https://chatgpt.com/backend-api/codex/responses', up: 123, down: 45, events: 1 });
  await recorder.close();
  const result = log.query({ from: 0, to: 120000 });
  assert.equal(result.totals.find(row => row.layer === 'cdp-websocket-message').up, 123);
  assert.equal(result.totals.find(row => row.layer === 'cdp-websocket-message').down, 45);
  assert.equal(result.totals.find(row => row.layer === 'socket-plaintext').up, 88);
  assert.equal(result.coverage.find(row => row.id === 'chromium').status, 'gap');
  log.close();
});

test('a known disconnect during trace flush is an incomplete capture, not a shutdown error', async () => {
  const log = new TrafficLog(':memory:'), recorder = new TrafficRecorder({ log, port: 1 });
  recorder.tracing = true;
  const client = { closed: false, socket: { readyState: WebSocket.OPEN }, close() {}, send: async () => {
    client.closed = true; throw Object.assign(new Error('CDP disconnected'), { code: 'CDP_DISCONNECTED' });
  } };
  recorder.client = client;
  await recorder.close();
  assert.equal(log.query().coverage.find(row => row.id === 'chromium').status, 'gap');
  log.close();
});

test('unexpected trace shutdown failure remains visible while available frames are saved', async () => {
  const log = new TrafficLog(':memory:'), recorder = new TrafficRecorder({ log, port: 1 });
  const original = new Error('unexpected trace failure');
  recorder.tracing = true;
  recorder.client = { closed: false, socket: { readyState: WebSocket.OPEN }, send: async () => { throw original; }, close() {} };
  recorder.frames.set('fixture', { at: 60000, category: 'model', endpoint: 'https://chatgpt.com/backend-api/codex/responses', up: 123, down: 45, events: 1 });
  await assert.rejects(recorder.close(), error => error === original);
  const result = log.query({ from: 0, to: 120000 });
  assert.equal(result.totals[0].up, 123);
  assert.equal(result.coverage.find(row => row.id === 'chromium').status, 'gap');
  log.close();
});

test('native already-ended response reconciles state without hiding the original error; unknown errors remain unchanged', async () => {
  for (const error of [Object.assign(new Error('Tracing is not started'), { code: -32000 }), new Error('actual failure')]) {
    const recorder = new TrafficRecorder({ filename: ':memory:', port: 1 });
    recorder.tracing = true;
    recorder.client = { send: async () => { throw error; }, close() {}, socket: { readyState: WebSocket.CLOSED } };
    await assert.rejects(recorder.endTrace(), actual => actual === error);
    assert.equal(recorder.tracing, error.code !== -32000);
    recorder.tracing = false; await recorder.close();
  }
});
