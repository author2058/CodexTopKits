import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { ModelTrafficMeter, meterWebSocket } from './model-traffic.mjs';

import WebSocket, { WebSocketServer } from 'ws';

function upstreamHeaders(headers, websocket = false) {
  const result = { ...headers };
  for (const key of ['host', 'connection', 'upgrade', 'proxy-connection', 'transfer-encoding']) delete result[key];
  if (websocket) for (const key of Object.keys(result)) if (key.startsWith('sec-websocket-')) delete result[key];
  return result;
}

export async function createImageReferenceProxy({ upstream = 'https://chatgpt.com', transform = async data => data, log = async () => {}, tls = null, httpOnly = false } = {}) {
  const token = randomBytes(24).toString('hex'), prefix = '/' + token;
  const sockets = new Set();
  const server = tls ? https.createServer(tls) : http.createServer();
  // The native caller owns inference deadlines; do not impose a shorter body timer.
  server.requestTimeout = 0;
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 0, perMessageDeflate: true });
  const targetFor = req => {
    if (!req.url.startsWith(prefix + '/backend-api/')) throw new Error('Unknown proxy route.');
    return new URL(req.url.slice(prefix.length), upstream);
  };
  const fail = (stage, error, signal) => {
    if (signal?.aborted && error.name === 'AbortError') {
      void log({ event: 'cancelled', stage, name: error.name, message: error.message });
      return;
    }
    void log({ event: 'failure', stage, name: error.name, message: error.message, stack: error.stack });
    console.error(stage, error);
  };
  server.on('request', (req, res) => {
    const controller = new AbortController(), signal = controller.signal;
    let meter;
    req.on('aborted', () => controller.abort(new DOMException('Native request aborted', 'AbortError')));
    res.on('close', () => { if (!res.writableFinished) controller.abort(new DOMException('Native response closed', 'AbortError')); });
    void (async () => {
      const url = targetFor(req), chunks = [];
      meter = new ModelTrafficMeter({ headers: req.headers, endpoint: url.origin + url.pathname, transport: 'http', log });
      for await (const chunk of req) chunks.push(chunk);
      const input = Buffer.concat(chunks);
      const output = await transform(input, { transport: 'http', path: url.pathname, headers: req.headers, signal, meter });
      signal.throwIfAborted();
      const headers = upstreamHeaders(req.headers);
      if (input.length || headers['content-length']) headers['content-length'] = String(output.length);
      await log({ event: 'http-send', method: req.method, path: url.pathname, nativeVersion: req.headers.version ?? null, before: input.length, after: output.length });
      const remote = (url.protocol === 'https:' ? https : http).request(url, { method: req.method, headers, signal }, response => {
        meter.record.status = response.statusCode;
        response.on('data', chunk => meter.add('down', chunk.length));
        response.on('end', () => meter.finish(true));
        response.on('aborted', () => meter.finish(false, new Error('Upstream response aborted')));
        response.on('error', error => meter.finish(false, error));
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
        void log({ event: 'http-response', path: url.pathname, status: response.statusCode });
      });
      remote.on('finish', () => meter.add('up', output.length));
      remote.on('error', error => { meter.finish(false, error); fail('http-upstream', error, signal); if (!res.headersSent) res.writeHead(502); res.end('Local model forwarding failed; see experiment log.'); });
      res.on('close', () => { if (!res.writableFinished) remote.destroy(); });
      remote.end(output);
    })().catch(error => { meter?.finish(false, error); fail('http-request', error, signal); if (!res.headersSent) res.writeHead(400); res.end(error.message); });
  });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = targetFor(req); }
    catch (error) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); fail('websocket-route', error); return; }
    if (httpOnly) {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      void log({ event: 'http-test-fallback', path: url.pathname, status: 426 });
      return;
    }
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const meter = new ModelTrafficMeter({ headers: req.headers, endpoint: url.origin + url.pathname, transport: 'websocket', log });
    const controller = new AbortController(), signal = controller.signal;
    const remote = new WebSocket(url, { headers: upstreamHeaders(req.headers, true), perMessageDeflate: Boolean(req.headers['sec-websocket-extensions']?.includes('permessage-deflate')), maxPayload: 0 });
    socket.on('close', () => { controller.abort(new DOMException('Native WebSocket closed', 'AbortError')); if (remote.readyState === WebSocket.CONNECTING || remote.readyState === WebSocket.OPEN) remote.close(); });
    sockets.add(remote);
    remote.on('close', code => { meter.finish(code === 1000 || code === 1001); sockets.delete(remote); controller.abort(new DOMException('Upstream WebSocket closed', 'AbortError')); });
    remote.on('unexpected-response', (_, response) => {
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`);
      response.pipe(socket);
      void log({ event: 'websocket-rejected', status: response.statusCode, path: url.pathname });
      meter.record.status = response.statusCode; meter.finish(false);
    });
    remote.on('error', error => { meter.finish(false, error); fail('websocket-upstream', error); socket.destroy(); });
    socket.on('error', error => { fail('websocket-local-socket', error); remote.close(); });
    remote.on('open', () => wsServer.handleUpgrade(req, socket, head, local => {
      meterWebSocket(remote, meter);
      meter.publish();
      sockets.add(local);
      void log({ event: 'websocket-connected', path: url.pathname, headerNames: Object.keys(req.headers), offeredExtensions: req.headers['sec-websocket-extensions'] ?? '', upstreamExtensions: remote.extensions, localExtensions: local.extensions });
      let pending = Promise.resolve();
      local.on('message', (data, binary) => {
        pending = pending.then(async () => {
          signal.throwIfAborted();
          const output = binary ? data : await transform(data, { transport: 'websocket', path: url.pathname, headers: req.headers, signal, meter });
          meter.add('messages', 1);
          signal.throwIfAborted();
          if (remote.readyState !== WebSocket.OPEN) throw new Error('Upstream WebSocket closed before send.');
          remote.send(output, { binary });
          await log({ event: 'websocket-send', path: url.pathname, nativeVersion: req.headers.version ?? null, before: data.length, after: output.length, binary });
        }).catch(error => { fail('websocket-transform', error, signal); local.close(1011, 'Image forwarding failed'); remote.close(); });
      });
      remote.on('message', (data, binary) => { if (local.readyState === WebSocket.OPEN) local.send(data, { binary }); });
      local.on('close', () => { sockets.delete(local); remote.close(); });
      local.on('error', error => { fail('websocket-client', error); remote.close(); });
      remote.on('close', (code, reason) => { if (local.readyState === WebSocket.OPEN) local.close(code === 1005 || code === 1006 ? 1011 : code, reason); });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}${prefix}/backend-api/`;
  return { baseUrl, token, server, async close() { for (const socket of sockets) socket.terminate(); wsServer.close(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
