import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTrafficService } from '../src/traffic-service.mjs';

test('reconnect and health checks join an initial capture instead of replacing it after it finishes', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bandwidth-capture-single-flight-'));
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); let reconnect, starts = 0, closes = 0;
  const client = { handlers: new Set(), closed: false, socket: { readyState: WebSocket.OPEN }, targets: () => [],
    async send(method) {
      if (method === 'Tracing.start') { starts++; entered.resolve(); await gate.promise; }
      if (method === 'Tracing.end') for (const handler of this.handlers) handler({ method: 'Tracing.tracingComplete', params: {} });
      return {};
    }, async close() { closes++; this.closed = true; },
  };
  const service = await createTrafficService({ stateDirectory, cdpPort: 12345,
    cdp: { acquire: async () => client, onReconnect(listener) { reconnect = listener; return () => { reconnect = null; }; } }, changed() {}, diagnostic() {} });
  t.after(async () => { await service.close(); assert.equal(reconnect, null); assert.equal(closes, 1); await fs.rm(stateDirectory, { recursive: true }); });
  const capture = service.setCapture(true); await entered.promise;
  const recovering = reconnect(), checking = service.check();
  gate.resolve(); await Promise.all([capture, recovering, checking]);
  assert.equal(starts, 1); assert.equal(closes, 0); assert.equal(client.handlers.size, 1);
});

test('recovery retries failed Network.enable on an open lease without restarting a healthy capture', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bandwidth-page-recovery-'));
  let failing = true, attempts = 0, starts = 0, errors = [];
  const client = { handlers: new Set(), closed: false, socket: { readyState: WebSocket.OPEN }, targets: () => [{ targetId: 'one', type: 'page', url: 'app://index.html' }],
    async send(method) {
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Network.enable') { attempts++; if (failing) throw Object.assign(new Error('CDP command timed out: Network.enable'), { code: 'CDP_COMMAND_TIMEOUT' }); }
      if (method === 'Tracing.start') starts++;
      if (method === 'Tracing.end') for (const handler of this.handlers) handler({ method: 'Tracing.tracingComplete', params: {} });
      return {};
    }, async close() { this.closed = true; },
  };
  const service = await createTrafficService({ stateDirectory, cdpPort: 12345, cdp: { acquire: async () => client, onReconnect: () => () => {} }, changed: value => { errors = value; }, diagnostic() {} });
  t.after(async () => { await service.close(); await fs.rm(stateDirectory, { recursive: true }); });
  await service.check(); assert.equal(attempts, 0, 'recovery does not turn on an unused collector');
  await service.setCapture(true); assert.equal(errors.length, 1);
  await service.check(); assert.equal(attempts, 2); assert.equal(errors.length, 1);
  failing = false; await service.check();
  assert.deepEqual(errors, []); assert.equal(attempts, 3); assert.equal(starts, 1);
  await service.check(); assert.equal(attempts, 3); assert.equal(starts, 1);
});

test('the service owns one database, preserves meter revisions and reports disabled optional sources', async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bandwidth-traffic-'));
  const failures = [], diagnostics = [];
  const service = await createTrafficService({ stateDirectory, changed: value => failures.push(value), diagnostic: entry => diagnostics.push(entry) });
  const started = Date.now();
  const record = { id: 'fixture', started, updated: started, revision: 1, threadId: 'fixture-thread', transport: 'http',
    endpoint: 'https://chatgpt.com/backend-api/codex/responses', up: 100, down: 200, logicalBefore: 300, logicalAfter: 100, imageUploadBytes: 42, cacheHits: 0, images: 1, messages: 1 };
  service.record({ event: 'model-traffic', metricsVersion: 1, record });
  service.record({ event: 'model-traffic', metricsVersion: 1, record });
  service.record({ event: 'model-traffic', metricsVersion: 1, record: { ...record, revision: 2, up: 150 } });
  const result = service.query({ from: started - 1, to: started + 1 });
  assert.equal(result.modelThreads[0].up, 150);
  assert.equal(result.modelThreads[0].imageUploadBytes, 42);
  assert.equal(result.coverage.find(item => item.id === 'chromium').status, 'disabled');
  assert.equal(result.coverage.find(item => item.id === 'windows-network').status, 'disabled');
  service.record({ event: 'model-traffic', metricsVersion: 1, record: { ...record, revision: 3, up: 150, measurementError: 'fixture-interface-gap' } });
  service.record({ event: 'model-traffic', metricsVersion: 1, record: { ...record, revision: 4, up: 150 } });
  assert.equal(service.query().coverage.find(item => item.id === 'model-metrics').status, 'error');
  service.record({ event: 'model-traffic', metricsVersion: 999, record });
  assert.ok(failures.at(-1).some(error => error.message === 'Unsupported model traffic metrics version.'));
  assert.match(diagnostics.find(item => item.source === 'model-threads').stack, /Unsupported model traffic/);
  assert.equal(service.query().coverage.find(item => item.id === 'model-threads').status, 'error');
  await service.close();
  service.record({ event: 'model-traffic', metricsVersion: 1, record });
});
