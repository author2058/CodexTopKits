import { randomUUID } from 'node:crypto';

// Only explicit native identifiers are retained. No request/response bodies,
// authorization headers, signed URL queries or image data enter these records.
export class ModelTrafficMeter {
  constructor({ headers = {}, endpoint, transport, log = async () => {} }) {
    this.log = log;
    this.record = { id: randomUUID(), started: Date.now(), updated: Date.now(), revision: 0,
      endpoint, transport, threadId: headers['thread-id'] || null,
      nativeRequestId: headers['x-client-request-id'] || null,
      up: 0, down: 0, logicalBefore: 0, logicalAfter: 0, imageUploadBytes: 0,
      cacheHits: 0, images: 0, messages: 0, complete: false,
      accounting: transport === 'websocket' ? 'websocket-frames' : 'http-body' };
  }
  changed() {
    // A shared upload can finish after its initiating caller cancelled. Retain
    // that later real transfer under the same owner instead of dropping it.
    if (this.finished) { this.publish(); return; }
    if (!this.timer && !this.finished) this.timer = setTimeout(() => { this.timer = null; this.publish(); }, 1000);
  }
  add(field, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid model traffic byte count: ' + field);
    this.record[field] += bytes; this.changed();
  }
  identify(request) {
    const id = request?.thread_id || request?.metadata?.thread_id;
    if (typeof id === 'string') {
      if (this.record.threadId && this.record.threadId !== id) {
        this.record.threadId = null; this.record.attributionError = 'conflicting-thread-identifiers';
      } else if (!this.record.attributionError) this.record.threadId = id;
    }
    if (typeof request?.model === 'string') this.record.model = request.model;
  }
  publish() {
    this.record.updated = Date.now(); this.record.revision++;
    void this.log({ event: 'model-traffic', metricsVersion: 1, record: { ...this.record } })
      .catch(error => console.error('Model traffic record failed:', error));
  }
  finish(complete, error) {
    if (this.finished) return;
    this.finished = true; clearTimeout(this.timer); this.timer = null;
    this.record.complete = complete;
    if (error) this.record.error = error.code || error.name || String(error);
    this.publish();
  }
}

// Observe the already compressed/masked frame buffers; do not compress again or
// await send callbacks. Receive chunks are decrypted WebSocket wire bytes, not
// decoded message lengths. This connection is attributed by its native headers.
export function meterWebSocket(socket, meter) {
  if (typeof socket._sender?.sendFrame !== 'function' || typeof socket._receiver?._write !== 'function') {
    meter.record.measurementError = 'websocket-frame-interface-unavailable';
    meter.publish(); return false;
  }
  const sender = socket._sender, sendFrame = sender.sendFrame;
  sender.sendFrame = function (list, callback) {
    const length = list.reduce((sum, chunk) => sum + chunk.length, 0);
    return sendFrame.call(this, list, error => {
      if (!error) meter.add('up', length);
      else { meter.record.measurementError = error.code || error.message; meter.changed(); }
      callback?.(error);
    });
  };
  const receiver = socket._receiver, write = receiver._write;
  receiver._write = function (chunk, encoding, callback) {
    meter.add('down', chunk.length);
    return write.call(this, chunk, encoding, callback);
  };
  // A peer may include an immediate message in its HTTP upgrade packet, which
  // ws consumes before emitting open. Do not pretend that earlier part was seen.
  if (receiver._bufferedBytes || receiver._fragmented || receiver._messageLength) {
    meter.record.measurementError = 'websocket-open-had-buffered-data'; meter.changed();
  }
  return true;
}
