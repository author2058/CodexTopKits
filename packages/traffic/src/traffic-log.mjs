import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function trafficEndpoint(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ? url.origin + url.pathname : null;
  } catch { return null; }
}

export function trafficCategory(value) {
  const endpoint = trafficEndpoint(value);
  if (!endpoint) return 'other';
  const url = new URL(endpoint), host = url.hostname, route = url.pathname;
  if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) return 'local';
  const openai = /(^|\.)(openai\.com|chatgpt\.com|oaiusercontent\.com)$/.test(host);
  if (/sentry|statsig|datadog/.test(host) || (openai && /^\/(ces|telemetry)\//.test(route))) return 'telemetry';
  if (openai && /\/(responses|chat\/completions|compact)(\/|$)/.test(route)) return 'model';
  if (openai && /pubsub|remote.control|\/realtime|\/voice|\/live/.test(route)) return 'realtime';
  if (openai && /\/files?(\/|$)|\/attachments?(\/|$)/.test(route)) return 'files';
  if (/oaiusercontent\.com$/.test(host)) return 'files';
  if (/microsoft|windowsupdate/.test(host) || (openai && /\/updates?(\/|$)/.test(route))) return 'updates';
  return openai ? 'app-api' : 'external';
}

// Content sizes are application payload sizes, never socket-byte estimates.
export function trafficContent(text) {
  const result = { jsonBytes: Buffer.byteLength(text), imageCount: 0, imageBase64Bytes: 0, imageBinaryBytes: 0, linkedImages: 0 };
  let json;
  try { json = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { representationBytes: result.jsonBytes, format: 'non-json-or-incomplete' };
  }
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && /^data:image\//i.test(child)) {
        const match = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(child);
        if (!match || match[2].length % 4 !== 0) { result.invalidImageData = true; continue; }
        result.imageCount++;
        result.imageBase64Bytes += match[2].length;
        result.imageBinaryBytes += match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
      } else if (typeof child === 'string' && ['image_url', 'url'].includes(key) && /^https?:/.test(child)
        && (key === 'image_url' || value.type === 'input_image' || value.type === 'image_url')) result.linkedImages++;
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(json);
  result.format = 'json';
  // Only identifiers useful for attribution are retained, not prompts or bodies.
  if (typeof json?.model === 'string') result.model = json.model;
  if (typeof json?.type === 'string') result.messageType = json.type;
  for (const key of ['thread_id', 'conversation_id', 'turn_id']) if (typeof json?.[key] === 'string') result[key] = json[key];
  return result;
}

const positive = value => Number.isSafeInteger(value) && value >= 0;
const headersValue = (headers, name) => {
  if (Array.isArray(headers)) return headers.find(header => header.startsWith(name + ': '))?.slice(name.length + 2);
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
};

export class TrafficLog {
  recoverCoverage(id, message) {
    this.db.prepare("UPDATE traffic_coverage SET status='info',message=?,updated=? WHERE id=? AND status='error'").run(message, Date.now(), id);
  }
  constructor(filename) {
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS traffic_requests (
        id TEXT PRIMARY KEY, started INTEGER NOT NULL, updated INTEGER NOT NULL, source TEXT NOT NULL,
        category TEXT NOT NULL, endpoint TEXT, target TEXT, method TEXT, status INTEGER,
        up INTEGER, down INTEGER, details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS traffic_request_time ON traffic_requests(started);
      CREATE TABLE IF NOT EXISTS traffic_bytes (
        minute INTEGER NOT NULL, layer TEXT NOT NULL, category TEXT NOT NULL, endpoint TEXT NOT NULL, pid INTEGER NOT NULL,
        up INTEGER NOT NULL, down INTEGER NOT NULL, events INTEGER NOT NULL,
        PRIMARY KEY(minute,layer,category,endpoint,pid));
      CREATE TABLE IF NOT EXISTS traffic_coverage (id TEXT PRIMARY KEY,status TEXT NOT NULL,message TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS traffic_connections (
        id TEXT PRIMARY KEY, firstSeen INTEGER NOT NULL,lastSeen INTEGER NOT NULL,pid INTEGER NOT NULL,
        process TEXT NOT NULL,protocol TEXT NOT NULL,local TEXT NOT NULL,remote TEXT,state TEXT);
      CREATE INDEX IF NOT EXISTS traffic_connection_time ON traffic_connections(lastSeen);
      CREATE TABLE IF NOT EXISTS traffic_model (
        id TEXT PRIMARY KEY, started INTEGER NOT NULL, updated INTEGER NOT NULL, revision INTEGER NOT NULL,
        threadId TEXT, transport TEXT NOT NULL, endpoint TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS traffic_model_samples (
        id TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL, threadId TEXT,
        up INTEGER NOT NULL, down INTEGER NOT NULL, logicalBefore INTEGER NOT NULL, logicalAfter INTEGER NOT NULL,
        imageUploadBytes INTEGER NOT NULL, cacheHits INTEGER NOT NULL, images INTEGER NOT NULL, messages INTEGER NOT NULL,
        PRIMARY KEY(id,revision));
      CREATE INDEX IF NOT EXISTS traffic_model_sample_time ON traffic_model_samples(at);`);
    this.putRequest = this.db.prepare(`INSERT INTO traffic_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,status=excluded.status,up=excluded.up,down=excluded.down,details=excluded.details`);
    this.putBytes = this.db.prepare(`INSERT INTO traffic_bytes VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(minute,layer,category,endpoint,pid)
      DO UPDATE SET up=up+excluded.up,down=down+excluded.down,events=events+excluded.events`);
    this.putCoverage = this.db.prepare('INSERT OR REPLACE INTO traffic_coverage VALUES (?,?,?,?)');
    this.putConnection = this.db.prepare(`INSERT INTO traffic_connections VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET lastSeen=excluded.lastSeen,state=excluded.state`);
  }
  coverage(id, status, message, updated = Date.now()) { this.putCoverage.run(id, status, message, updated); }
  request(record) {
    this.putRequest.run(record.id, record.started, record.updated || Date.now(), record.source, record.category,
      record.endpoint || null, record.target || null, record.method || null, record.status ?? null,
      record.up ?? null, record.down ?? null, JSON.stringify(record.details || {}));
  }
  bytes(at, layer, category, endpoint, pid, up, down, events = 1) {
    if (![up, down].every(positive)) throw new Error('Invalid measured traffic byte count.');
    this.putBytes.run(Math.floor(at / 60000) * 60000, layer, category, endpoint || '', pid || 0, up, down, events);
  }
  model(record) {
    record = { ...record, category: trafficCategory(record.endpoint) };
    const fields = ['up', 'down', 'logicalBefore', 'logicalAfter', 'imageUploadBytes', 'cacheHits', 'images', 'messages'];
    if (typeof record.id !== 'string' || ![record.started, record.updated, record.revision, ...fields.map(key => record[key])].every(positive)
      || !['http', 'websocket'].includes(record.transport) || !trafficEndpoint(record.endpoint)) throw new Error('Invalid model traffic record.');
    const previous = this.db.prepare('SELECT revision,threadId,details FROM traffic_model WHERE id=?').get(record.id);
    if (previous && previous.revision >= record.revision) return;
    const prior = previous ? JSON.parse(previous.details) : {};
    const delta = fields.map(key => record[key] - (prior[key] || 0));
    if (!delta.every(positive)) throw new Error('Model traffic counters moved backwards.');
    const threadId = record.attributionError ? null : record.threadId || null;
    this.db.prepare('INSERT OR REPLACE INTO traffic_model VALUES (?,?,?,?,?,?,?,?)')
      .run(record.id, record.started, record.updated, record.revision, threadId, record.transport, record.endpoint, JSON.stringify(record));
    if (previous && previous.threadId !== threadId) this.db.prepare('UPDATE traffic_model_samples SET threadId=? WHERE id=?').run(threadId, record.id);
    this.db.prepare('INSERT INTO traffic_model_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(record.id, record.revision, record.updated, threadId, ...delta);
  }
  connections(records, at = Date.now()) {
    this.db.exec('BEGIN');
    try {
      for (const row of records) this.putConnection.run(`${row.pid}:${row.protocol}:${row.local}:${row.remote || ''}`, at, at,
        row.pid, row.process, row.protocol, row.local, row.remote || null, row.state || null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  query({ from = Date.now() - 86400000, to = Date.now(), category = '' } = {}) {
    if (![from, to].every(positive) || to < from) throw new Error('Invalid traffic time range.');
    const filter = category ? ' AND category=?' : '', args = category ? [from, to, category] : [from, to];
    const metricArgs = category ? [Math.floor(from / 60000) * 60000, to, category] : [Math.floor(from / 60000) * 60000, to];
    return { source: this.filename, queriedAt: new Date().toISOString(), from, to,
      coverage: this.db.prepare('SELECT * FROM traffic_coverage ORDER BY id').all().map(row =>
        row.id === 'windows-network' && row.status === 'active' && Date.now() - row.updated > 5000
          ? { ...row, status: 'gap', message: 'Windows 流量记录暂未更新；正在等待新记录，已保存的数据不受影响。' } : row),
      totals: this.db.prepare(`SELECT layer,category,SUM(up) AS up,SUM(down) AS down,SUM(events) AS events
        FROM traffic_bytes WHERE minute>=? AND minute<=?${filter} GROUP BY layer,category ORDER BY up DESC`).all(...metricArgs),
      endpoints: this.db.prepare(`SELECT layer,category,endpoint,SUM(up) AS up,SUM(down) AS down,SUM(events) AS events
        FROM traffic_bytes WHERE minute>=? AND minute<=?${filter} GROUP BY layer,category,endpoint ORDER BY up DESC LIMIT 100`).all(...metricArgs),
      requests: this.db.prepare(`SELECT * FROM traffic_requests WHERE started>=? AND started<=?${filter} ORDER BY started DESC LIMIT 100`).all(...args)
        .map(row => ({ ...row, details: JSON.parse(row.details) })),
      connections: this.db.prepare('SELECT * FROM traffic_connections WHERE lastSeen>=? AND firstSeen<=? ORDER BY lastSeen DESC LIMIT 100').all(from, to),
      modelThreads: this.db.prepare(`SELECT s.threadId,
        SUM(s.up) AS up,SUM(s.down) AS down,SUM(s.logicalBefore) AS logicalBefore,SUM(s.logicalAfter) AS logicalAfter,
        SUM(s.imageUploadBytes) AS imageUploadBytes,SUM(s.cacheHits) AS cacheHits,SUM(s.images) AS images,SUM(s.messages) AS messages,
        COUNT(DISTINCT CASE WHEN json_extract(m.details,'$.measurementError') IS NOT NULL OR json_extract(m.details,'$.attributionError') IS NOT NULL THEN m.id END) AS gaps
        FROM traffic_model_samples s JOIN traffic_model m ON m.id=s.id WHERE s.at>=? AND s.at<=?
        ${category ? "AND json_extract(m.details,'$.category')=?" : ''} GROUP BY s.threadId ORDER BY up DESC`).all(...args),
      modelRecords: this.db.prepare(`SELECT details FROM traffic_model WHERE updated>=? AND started<=?
        ${category ? "AND json_extract(details,'$.category')=?" : ''} ORDER BY updated DESC LIMIT 100`)
        .all(...args).map(row => JSON.parse(row.details)),
    };
  }
  close() { this.db.close(); }
}

export function recordNetlog(log, events, { id = randomUUID(), started = Date.now(), ended = Date.now() } = {}) {
  const relevant = events.filter(event => event.cat?.split(',').includes('netlog'));
  const marker = events.find(event => event.name === 'clock_sync' && event.args?.sync_id?.startsWith('cdt:'));
  const offset = marker ? Number(marker.args.sync_id.slice(4)) - marker.ts / 1000
    : ended - relevant.reduce((maximum, event) => Math.max(maximum, event.ts / 1000), 0);
  const streams = new Map(), requests = new Map();
  const source = event => `${event.pid}:${event.id2?.local || event.id}`;
  const time = event => marker ? Math.round(event.ts / 1000 + offset) : Math.max(started, Math.min(ended, Math.round(event.ts / 1000 + offset)));
  log.db.exec('BEGIN');
  try {
    for (const event of relevant) {
      const p = event.args?.params || {}, key = source(event), at = time(event);
      if (event.name === 'URL_REQUEST_START_JOB' && event.ph !== 'e' && p.url) requests.set(key, trafficEndpoint(p.url));
      if (event.name === 'HTTP2_SESSION_SEND_HEADERS') {
        const host = headersValue(p.headers, ':authority'), route = headersValue(p.headers, ':path');
        if (!host || !route) continue;
        const endpoint = trafficEndpoint(`https://${host}${route}`);
        const record = { id: `${id}:${key}:${p.stream_id}`, source: 'netlog-http2', started: at, updated: at,
          category: trafficCategory(endpoint), endpoint, method: headersValue(p.headers, ':method'), up: 0, down: 0,
          details: { pid: event.pid, contentEncoding: headersValue(p.headers, 'content-encoding') || 'identity',
            declaredContentLength: headersValue(p.headers, 'content-length') ?? null, clock: marker ? 'clock-sync' : 'capture-end-aligned', captureStarted: started, captureEnded: ended } };
        streams.set(`${key}:${p.stream_id}`, record);
      }
      if (['HTTP2_SESSION_SEND_DATA', 'HTTP2_SESSION_RECV_DATA'].includes(event.name)) {
        if (!positive(p.size)) throw new Error('NetLog HTTP/2 DATA has no valid size.');
        const record = streams.get(`${key}:${p.stream_id}`), outgoing = event.name.includes('SEND');
        if (record) { record[outgoing ? 'up' : 'down'] += p.size; record.updated = at; }
        log.bytes(at, 'http2-data', record?.category || 'unattributed', record?.endpoint, event.pid, outgoing ? p.size : 0, outgoing ? 0 : p.size);
      }
      if (event.name === 'HTTP2_SESSION_RECV_HEADERS') {
        const record = streams.get(`${key}:${p.stream_id}`), status = Number(headersValue(p.headers, ':status'));
        if (record && Number.isInteger(status) && status >= 100) record.status = status;
      }
      if (['HTTP2_SESSION_SEND_RST_STREAM', 'HTTP2_SESSION_RECV_RST_STREAM'].includes(event.name)) {
        const record = streams.get(`${key}:${p.stream_id}`);
        if (record) record.details.reset = { event: event.name, code: p.error_code };
      }
      if (['SOCKET_BYTES_SENT', 'SOCKET_BYTES_RECEIVED', 'SSL_SOCKET_BYTES_SENT', 'SSL_SOCKET_BYTES_RECEIVED', 'UDP_BYTES_SENT', 'UDP_BYTES_RECEIVED'].includes(event.name)) {
        if (!positive(p.byte_count)) throw new Error('NetLog socket event has no valid byte_count.');
        const outgoing = event.name.endsWith('SENT');
        log.bytes(at, event.name.startsWith('SSL_') ? 'socket-plaintext' : event.name.startsWith('UDP_') ? 'udp-transport' : 'socket-transport', 'all-chromium', '', event.pid,
          outgoing ? p.byte_count : 0, outgoing ? 0 : p.byte_count);
      }
      if (['WEBSOCKET_SENT_FRAME_HEADER', 'WEBSOCKET_RECV_FRAME_HEADER'].includes(event.name)) {
        if (!positive(p.payload_length)) throw new Error('NetLog WebSocket frame has no valid payload_length.');
        const endpoint = requests.get(key), outgoing = event.name.includes('SENT');
        log.bytes(at, 'netlog-websocket-payload', endpoint ? trafficCategory(endpoint) : 'unattributed', endpoint, event.pid,
          outgoing ? p.payload_length : 0, outgoing ? 0 : p.payload_length);
      }
    }
    for (const record of streams.values()) log.request(record);
    log.db.exec('COMMIT');
  } catch (error) { log.db.exec('ROLLBACK'); throw error; }
  return { events: relevant.length, requests: streams.size, clock: marker ? 'clock-sync' : 'capture-end-aligned' };
}

export class TrafficRecorder {
  constructor({ filename, log, port, cdp, signal, readConnections, onError = console.error, onDiagnostic = () => {}, onRecovered = () => {} }) {
    this.ownsLog = !log;
    this.log = log ?? new TrafficLog(filename); this.port = port; this.cdp = cdp; this.signal = signal; this.readConnections = readConnections; this.onError = onError;
    this.runId = randomUUID(); this.client = null; this.closed = false; this.sessions = new Map(); this.attached = new Set();
    this.onDiagnostic = onDiagnostic; this.onRecovered = onRecovered;
    this.unresolvedWorkers = new Set();
    this.requests = new Map(); this.sockets = new Map(); this.frames = new Map(); this.traceEvents = []; this.tracing = false;
    this.log.coverage('native-content', 'info', process.env.CODEX_ROLLOUT_TRACE_ROOT
      ? `原生完整请求记录目录：${process.env.CODEX_ROLLOUT_TRACE_ROOT}。记录包含文字和图片，实际写入请核对该目录中的最新文件；正文大小不是网络字节数。`
      : '原生完整请求记录未配置，不保存其提示词或图片。');
    this.log.coverage('native-wire', 'gap', '原生 codex.exe 的传输字节目前未接入，不包含在 Chromium 计数内；其 TCP 连接会单独记录。');
    this.log.coverage('capture-boundary', 'info', '从启用后开始记录。不同统计层有重叠，不能相加；连接层包含回环／代理连接，不含 TCP 重传、IP 开销或路由器封装。');
  }
  failure(id, error) {
    if (this.closed) return;
    this.log.coverage(id, 'error', `${error.name}: ${error.message}`);
    this.onError(error, id);
  }
  recovered(id, message = '此前的采集错误已恢复。') {
    this.log.recoverCoverage(id, message);
    this.onRecovered(id);
  }
  async start() {
    if (!this.cdp && !Number.isInteger(this.port)) throw new Error('Standalone Chromium capture requires an explicit CDP port.');
    if (!this.cdp) { const { createCdpService } = await import('codex-toolkit-core/cdp'); this.ownedCdp = await createCdpService([this.port]); }
    this.client = await (this.cdp || this.ownedCdp.forOwner('traffic')).acquire({ signal: this.signal });
    this.recovered('cdp-protocol');
    this.client.onError = error => this.failure('cdp-protocol', error);
    this.client.onClose = () => {
      if (!this.closed) this.failure('chromium', new Error('调试连接断开；采集已暂停，等待调试连接恢复。'));
      this.traceFailed?.(Object.assign(new Error('CDP disconnected before the trace flush completed.'), { code: 'CDP_DISCONNECTED' }));
      clearTimeout(this.timer);
    };
    this.client.handlers.add(message => { void this.receive(message).catch(error => this.failure('page-network', error)); });
    await Promise.all(this.client.targets().map(info => this.attachObserved(info)));
    if (!this.paused) {
      try { await this.startTrace(); }
      catch (error) { this.failure('chromium', error); }
    } else { this.log.coverage('chromium', 'paused', '应用级字节采集已暂停；页面请求记录已恢复。'); this.recovered('chromium'); }
    this.log.coverage('page-network', 'active', '已监听主页面、内置浏览器和可访问 worker 的请求、调用来源及 WebSocket 消息大小；正文只保留大小及图片构成，不落盘。');
    void this.sampleConnections();
  }
  async attach(info) {
    if (!['page', 'iframe', 'webview', 'worker', 'service_worker'].includes(info.type) || this.attached.has(info.targetId)) return;
    // Current Electron exposes empty worker targets that answer neither Runtime
    // nor Schema commands. Wait for their real target URL, not a longer timeout.
    if (info.type === 'worker' && !info.url) {
      if (!this.unresolvedWorkers.has(info.targetId)) { this.unresolvedWorkers.add(info.targetId); this.workerCoverage(); }
      return;
    }
    if (this.unresolvedWorkers.delete(info.targetId)) this.workerCoverage();
    this.attached.add(info.targetId);
    let sessionId;
    try {
      ({ sessionId } = await this.client.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }));
      this.sessions.set(sessionId, info.targetId);
      await this.client.send('Network.enable', {}, sessionId);
      this.recovered('page-target:' + info.targetId);
    } catch (error) {
      this.attached.delete(info.targetId); this.sessions.delete(sessionId);
      if (sessionId && !this.client.closed) {
        try { await this.client.send('Target.detachFromTarget', { sessionId }); }
        catch (cleanup) { if (cleanup.code !== 'CDP_TARGET_CLOSED') throw new AggregateError([error, cleanup], 'Network initialization and cleanup failed.', { cause: error }); }
      }
      throw error;
    }
  }
  async attachObserved(info) {
    try { await this.attach(info); }
    catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') this.failure('page-target:' + info.targetId, new Error(`${info.type} ${info.targetId}: ${error.message}`, { cause: error })); }
  }
  workerCoverage() {
    this.log.coverage('anonymous-workers', this.unresolvedWorkers.size ? 'gap' : 'info',
      this.unresolvedWorkers.size ? `${this.unresolvedWorkers.size} 个空地址 worker 不响应调试命令，暂不能读取其调用来源；其经过 Chromium 的网络字节仍由应用级记录覆盖。` : '没有尚待识别的空地址 worker。');
  }
  startTrace() {
    if (this.starting) return this.starting;
    this.starting = this.startTraceOnce().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startTraceOnce() {
    if (this.tracing || this.ending) throw new Error('Traffic trace is still owned by the previous capture.');
    this.traceEvents = []; this.traceStarted = Date.now();
    const start = () => this.client.send('Tracing.start', { categories: 'netlog', options: 'record-as-much-as-possible', transferMode: 'ReportEvents' });
    try { await start(); }
    catch (error) {
      if (error.code !== 'CDP_COMMAND_TIMEOUT' || this.client.closed || this.client.traceState !== 'uncertain') throw error;
      this.failure('chromium', error);
      this.tracing = true;
      // The shared CDP owner retains an unacknowledged start; settle its own session before retrying.
      try { await this.endTrace(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Traffic start and owned trace cleanup failed.', { cause: error }); }
      if (this.closed || this.paused || this.client.closed) return;
      if (this.traceEvents.length) recordNetlog(this.log, this.traceEvents, { started: this.traceStarted, ended: Date.now() });
      this.traceEvents = []; this.traceStarted = Date.now();
      await start();
    }
    this.tracing = true;
    this.onDiagnostic({ event: 'traffic-trace-started', started: this.traceStarted });
    if (this.closed || this.paused || this.client.closed) return;
    await this.client.send('Tracing.recordClockSyncMarker', { syncId: `cdt:${Date.now()}` });
    this.log.coverage('chromium', 'active', '应用级 Chromium 网络计数已开启，每 30 秒保存；不保存原始报文。已有长连接或跨采集段请求无法归类的部分明确列为“未归类”。');
    this.recovered('chromium');
    this.timer = setTimeout(() => { this.rotation = this.rotate().catch(error => this.failure('chromium', error)); }, 30000);
  }
  async endTrace() {
    if (this.ending) return this.ending;
    if (!this.tracing) return;
    const uncertainStart = this.client.traceState === 'uncertain';
    const started = Date.now();
    this.onDiagnostic({ event: 'traffic-trace-ending', started, captureStarted: this.traceStarted });
    let timer;
    const complete = new Promise((resolve, reject) => {
      // This is a background flush allowance, not a measured completion bound.
      // Ordinary CDP commands keep their existing 8-second budget.
      timer = setTimeout(() => reject(new Error('Traffic trace flush did not complete within 60 seconds.')), 60000);
      this.traceDone = resolve; this.traceFailed = reject;
    });
    const ended = this.client.send('Tracing.end', {}, undefined, 60000).catch(error => {
      if (error.code !== -32000 || error.message !== 'Tracing is not started') throw error;
      this.tracing = false;
      if (!uncertainStart) throw error;
      this.traceDone?.();
    });
    this.ending = Promise.all([ended, complete]).finally(() => {
        clearTimeout(timer); this.traceDone = null; this.traceFailed = null; this.ending = null;
        this.onDiagnostic({ event: 'traffic-trace-end-settled', elapsedMs: Date.now() - started, tracing: this.tracing });
      });
    return this.ending;
  }
  async rotate() {
    clearTimeout(this.timer);
    await this.endTrace();
    const events = this.traceEvents, started = this.traceStarted, ended = Date.now();
    this.traceEvents = [];
    let startError;
    try { if (!this.closed && !this.paused) await this.startTrace(); } catch (error) { startError = error; }
    try {
      recordNetlog(this.log, events, { started, ended });
      this.flushFrames();
      this.log.coverage('last-flush', 'info', `最近保存：${new Date().toISOString()}；原始网络事件 ${events.filter(e => e.cat?.includes('netlog')).length} 条。`);
    } catch (error) {
      if (startError) throw new AggregateError([startError, error], 'Traffic restart and flush failed.', { cause: startError });
      throw error;
    }
    if (startError) throw startError;
  }
  async setTracing(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Capture enabled must be boolean.');
    if (enabled && this.tracing && !this.paused) return { enabled: true };
    this.paused = !enabled;
    clearTimeout(this.timer);
    await this.rotation;
    await this.starting;
    if (enabled) {
      if (!this.tracing) await this.startTrace();
    } else {
      await this.endTrace();
      if (this.traceEvents.length) recordNetlog(this.log, this.traceEvents, { started: this.traceStarted, ended: Date.now() });
      this.traceEvents = [];
      this.log.coverage('chromium', 'paused', '应用级字节采集已暂停，已释放浏览器 Tracing；页面与进程连接记录仍运行。重启控制器后默认继续采集。');
    }
    return { enabled: this.tracing && !this.paused };
  }
  async sampleConnections() {
    if (!this.readConnections || this.closed) return;
    try {
      const records = await this.readConnections();
      if (!this.closed) {
        this.log.connections(records);
        this.log.coverage('connections', 'active', '每 30 秒记录 Codex／ChatGPT 进程的 TCP 连接与 UDP 绑定；包括原生运行时，但不提供其加密请求正文或字节量，可能漏掉短连接。');
      }
    } catch (error) { this.failure('connections', error); return; }
    if (!this.closed) this.connectionTimer = setTimeout(() => { void this.sampleConnections(); }, 30000);
  }
  async receive(message) {
    const p = message.params || {}, target = this.sessions.get(message.sessionId);
    if (message.method === 'Tracing.dataCollected') { this.traceEvents.push(...p.value); return; }
    if (message.method === 'Tracing.tracingComplete') {
      const expected = Boolean(this.traceDone);
      this.tracing = false;
      this.onDiagnostic({ event: 'traffic-trace-complete', expected, events: this.traceEvents.length, dataLossOccurred: Boolean(p.dataLossOccurred) });
      if (p.dataLossOccurred) this.failure('trace-buffer', new Error('Chromium reported lost trace events; byte totals are incomplete.'));
      this.traceDone?.();
      if (!expected && !this.closed && !this.paused) this.rotation = this.rotate().catch(error => this.failure('chromium', error));
      return;
    }
    if (this.closed) return;
    if (message.method === 'Target.targetCreated') return this.attachObserved(p.targetInfo);
    if (message.method === 'Target.targetInfoChanged' && this.unresolvedWorkers.has(p.targetInfo?.targetId) && p.targetInfo.url) return this.attachObserved(p.targetInfo);
    if (message.method === 'Target.targetDestroyed') {
      if (this.unresolvedWorkers.delete(p.targetId)) this.workerCoverage();
      this.attached.delete(p.targetId);
      this.recovered('page-target:' + p.targetId, '采集目标已关闭。');
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      this.attached.delete(this.sessions.get(p.sessionId)); this.sessions.delete(p.sessionId);
      for (const [key, record] of this.requests) if (record.sessionId === p.sessionId) { record.details.error = 'target-detached'; this.log.request(record); this.requests.delete(key); }
      for (const key of this.sockets.keys()) if (key.startsWith(p.sessionId + ':')) this.sockets.delete(key);
      return;
    }
    if (!target) return;
    const key = `${message.sessionId}:${p.requestId}`;
    if (message.method === 'Network.requestWillBeSent') {
      const endpoint = trafficEndpoint(p.request.url);
      if (!endpoint || trafficCategory(endpoint) === 'local') return;
      const prior = this.requests.get(key);
      if (prior) { prior.details.redirected = true; this.log.request(prior); }
      const frame = p.initiator?.stack?.callFrames?.[0];
      const record = { id: `${this.runId}:page:${key}:${p.timestamp}`, sessionId: message.sessionId, started: Math.round(p.wallTime * 1000),
        source: 'cdp-page', category: trafficCategory(endpoint), endpoint, target, method: p.request.method,
        details: { resourceType: p.type, initiator: frame ? { url: frame.url?.split('?')[0], functionName: frame.functionName, line: frame.lineNumber } : { type: p.initiator?.type } } };
      this.requests.set(key, record); this.log.request(record);
      if (p.request.postData) record.details.content = trafficContent(p.request.postData);
      else if (p.request.hasPostData) {
        try {
          const data = await this.client.send('Network.getRequestPostData', { requestId: p.requestId }, message.sessionId);
          record.details.content = trafficContent(data.postData);
        } catch (error) {
          record.details.contentUnavailable = error.message;
          if (!/No (resource|post data)|not found|No data|closed|detached|disconnected/i.test(error.message)) throw error;
        }
      }
      if (!this.closed) this.log.request(record);
    } else if (message.method === 'Network.responseReceived') {
      const record = this.requests.get(key); if (!record) return;
      record.status = p.response.status; record.details.protocol = p.response.protocol; record.details.fromCache = p.response.fromDiskCache || p.response.fromServiceWorker || false;
      record.details.remoteIPAddress = p.response.remoteIPAddress; record.details.remotePort = p.response.remotePort;
    } else if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) {
      const record = this.requests.get(key); if (!record) return;
      record.updated = Date.now();
      if (message.method.endsWith('Finished')) record.details.encodedResponseBytes = p.encodedDataLength;
      else record.details.error = p.errorText;
      this.log.request(record); this.requests.delete(key);
    } else if (message.method === 'Network.webSocketCreated') {
      const endpoint = trafficEndpoint(p.url);
      if (endpoint && trafficCategory(endpoint) !== 'local') this.sockets.set(key, { endpoint, category: trafficCategory(endpoint), target });
    } else if (['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(message.method)) {
      const socket = this.sockets.get(key); if (!socket) return;
      const frame = p.response, outgoing = message.method.endsWith('Sent');
      const bytes = frame.opcode === 1 ? Buffer.byteLength(frame.payloadData) : Buffer.from(frame.payloadData, 'base64').length;
      const at = Math.floor(Date.now() / 60000) * 60000, bucketKey = `${at}:${socket.endpoint}`;
      const bucket = this.frames.get(bucketKey) || { at, ...socket, up: 0, down: 0, events: 0 };
      bucket[outgoing ? 'up' : 'down'] += bytes; bucket.events++; this.frames.set(bucketKey, bucket);
      if (!this.frameTimer) this.frameTimer = setTimeout(() => {
        this.frameTimer = null;
        try { this.flushFrames(); } catch (error) { this.failure('page-network', error); }
      }, 5000);
      if (outgoing && frame.opcode === 1 && socket.category === 'model') this.log.request({
        id: `${this.runId}:ws:${key}:${p.timestamp}`, started: Date.now(), source: 'cdp-websocket', category: socket.category,
        endpoint: socket.endpoint, target, method: 'WS SEND', details: { content: trafficContent(frame.payloadData), payloadBytes: bytes },
      });
    } else if (message.method === 'Network.webSocketClosed') this.sockets.delete(key);
  }
  flushFrames() {
    clearTimeout(this.frameTimer); this.frameTimer = null;
    if (!this.frames.size) return;
    this.log.db.exec('BEGIN');
    try {
      for (const bucket of this.frames.values()) this.log.bytes(bucket.at, 'cdp-websocket-message', bucket.category, bucket.endpoint, 0, bucket.up, bucket.down, bucket.events);
      this.log.db.exec('COMMIT'); this.frames.clear();
    } catch (error) { this.log.db.exec('ROLLBACK'); throw error; }
  }
  query(filters) { this.flushFrames(); return this.log.query(filters); }
  async close() {
    this.closed = true; clearTimeout(this.timer); clearTimeout(this.connectionTimer); clearTimeout(this.frameTimer);
    const errors = [];
    let incomplete = Boolean(this.tracing && this.client?.closed);
    const expectedDisconnection = error => this.client?.closed && ['CDP_DISCONNECTED', 'CDP_TARGET_CLOSED', 'CDP_COMMAND_TIMEOUT'].includes(error?.code);
    for (const work of [this.starting, this.rotation]) {
      try { await work; }
      catch (error) { incomplete = true; if (!expectedDisconnection(error) && !errors.includes(error)) errors.push(error); }
    }
    try {
      if (this.tracing && !this.client?.closed && this.client?.socket.readyState === WebSocket.OPEN) await this.endTrace();
      if (this.tracing && this.client?.closed) incomplete = true;
    } catch (error) { incomplete = true; if (!expectedDisconnection(error)) errors.push(error); }
    try { if (this.traceEvents.length) recordNetlog(this.log, this.traceEvents, { started: this.traceStarted, ended: Date.now() }); }
    catch (error) { incomplete = true; errors.push(error); }
    try { this.flushFrames(); } catch (error) { incomplete = true; errors.push(error); }
    try { for (const record of this.requests.values()) { record.details.observationEnded = true; this.log.request(record); } }
    catch (error) { incomplete = true; errors.push(error); }
    try { this.log.coverage('chromium', incomplete ? 'gap' : 'stopped', incomplete ? '采集结束时连接已中断或刷新失败，已保存可用记录，但最后一段可能不完整。' : '控制器已停止，本次采集结束。'); }
    catch (error) { errors.push(error); }
    try { await this.client?.close(); } catch (error) { errors.push(error); }
    try { await this.ownedCdp?.close(); } catch (error) { errors.push(error); }
    try { if (this.ownsLog) this.log.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Traffic recorder cleanup failed.', { cause: errors[0] });
  }
}
