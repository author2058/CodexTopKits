import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import runtime from 'codex-toolkit-core/kit-runtime';
import { kitModule } from 'codex-toolkit-core/kits';
import observerKit from '../kits/traffic-observer/index.mjs';
import createTrafficObserverKitService from '../src/traffic-observer-kit-service.mjs';
import { createTrafficObserverRouter } from '../src/traffic-observer-router.mjs';
import { createTrafficService } from '../src/traffic-service.mjs';
import { bandwidthPlugin } from '../src/index.mjs';

test('traffic Kit updates its actual collector and keeps the SQLite history', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-traffic-kit-')); t.after(() => fs.rm(root, { recursive: true }));
  const packer = path.join(path.dirname(fileURLToPath(import.meta.resolve('codex-toolkit-core/kits'))), 'feature-pack.mjs');
  const entry = fileURLToPath(new URL('../kits/traffic-observer/index.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [packer, entry, root], { windowsHide: true, encoding: 'utf8' });
  const initial = JSON.parse(stdout).output, candidate = path.join(root, 'candidate'); await fs.cp(initial, candidate, { recursive: true });
  const manifest = { ...observerKit.manifest, version: '0.2.0' };
  await fs.writeFile(path.join(candidate, 'kit.json'), JSON.stringify(manifest), 'utf8'); await fs.writeFile(path.join(candidate, 'index.mjs'), kitModule({ ...observerKit, manifest }), 'utf8');
  const trafficDirectory = path.join(root, 'traffic'), stateDirectory = path.join(root, 'runtime'); await fs.mkdir(trafficDirectory); await fs.mkdir(stateDirectory);
  const router = await createTrafficObserverRouter(null, { stateDirectory: trafficDirectory, changed() {}, diagnostic() {} });
  let setups = 0;
  const owner = { trafficObserverControl: () => ({ handedOff: true }), setTrafficObserver: factory => { setups++; return router.replace(factory); }, disableTrafficObserver: () => router.replace(null) };
  const client = { handlers: new Set(), closed: false, targets: () => [], async close() { this.closed = true; } }; let acquisitions = 0, releaseCdp;
  const cdpReady = new Promise(resolve => { releaseCdp = resolve; });
  const context = { stateDirectory, cdp: { acquire: async () => { acquisitions++; return cdpReady; }, onReconnect: () => () => {} }, getPlugin: id => id === 'bandwidth' ? owner : null,
    log: async () => {}, setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  const factory = Object.assign((...args) => createTrafficObserverKitService(...args), { serviceApiVersion: '1.0.0' });
  const instance = await runtime({ artifacts: [initial], services: { 'traffic-observer': { module: 'unused', startBeforeCdp: true } } }, { serviceFactories: { 'traffic-observer': factory } }).start(context);
  try {
    assert.equal(instance.snapshot().phase, 'waiting-for-app'); const started = Date.now();
    const row = { id: 'fixture', started, updated: started, revision: 1, threadId: 'thread', transport: 'http', endpoint: 'https://example.test/model', up: 100, down: 200, logicalBefore: 100, logicalAfter: 100, imageUploadBytes: 0, cacheHits: 0, images: 0, messages: 1 };
    router.record({ event: 'model-traffic', metricsVersion: 1, record: row }); assert.equal((await router.query({})).modelThreads[0].up, 100);
    releaseCdp(client); await instance.connect(); assert.equal(setups, 1);
    const first = instance.snapshot().hostPid; await instance.prepare('traffic-observer', candidate); await instance.restart();
    assert.equal(instance.snapshot().features[0].version, '0.2.0'); assert.notEqual(instance.snapshot().hostPid, first); assert.equal(acquisitions, 1); assert.equal(client.closed, false);
    router.record({ event: 'model-traffic', metricsVersion: 1, record: { ...row, revision: 2, up: 150 } }); assert.equal((await router.query({})).modelThreads[0].up, 150);
    instance.select('traffic-observer', false); await instance.restart(); await assert.rejects(router.query({}), /未启用/);
  } finally { releaseCdp(client); await instance.close(); await router.close(); }
});

test('Bandwidth can enable and disable the observer without closing its transport', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-traffic-owner-')); t.after(() => fs.rm(stateDirectory, { recursive: true }));
  const health = [], owner = await bandwidthPlugin({ externalKits: ['traffic-observer'] }).start({ stateDirectory, setHealth(value) { health.push(value); }, log: async () => {} });
  const target = new URL(owner.launchEnvironment.CODEX_APP_SERVER_OPENAI_BASE_URL), socket = tls.connect({ host: target.hostname, port: Number(target.port), ca: await fs.readFile(owner.launchEnvironment.CODEX_CA_CERTIFICATE) });
  try {
    await once(socket, 'secureConnect'); assert.equal(socket.authorized, true);
    const query = () => owner.management.request({ method: 'GET', url: new URL('http://localhost/api/traffic') });
    await assert.rejects(query(), /未启用/); let reportErrors;
    await owner.setTrafficObserver(options => { reportErrors = options.changed; return createTrafficService(options); }); assert.deepEqual((await query()).body.modelThreads, []);
    assert.match(health.at(-1).messageLocales['zh-Hans'], /流量观察已启用/);
    reportErrors([new Error('original upstream traffic failure')]);
    assert.match(health.at(-1).messageLocales.en, /Traffic: original upstream traffic failure/);
    assert.match(health.at(-1).messageLocales['zh-Hans'], /流量：original upstream traffic failure/);
    const busy = Object.assign(new Error('Tracing has already been started (possibly in another tab).'), { code: -32000 });
    reportErrors([new Error('original upstream traffic failure'), busy], [{ key: 'first', message: 'original upstream traffic failure' }, { key: 'chromium', message: busy.message }]);
    assert.equal(health.at(-1).issueCount, 2); assert.equal(health.at(-1).recoverable, false);
    assert.deepEqual(health.at(-1).issues.map(issue => issue.key), ['first', 'chromium']);
    assert.match(health.at(-1).messageLocales.en, /Tracing has already been started/);
    reportErrors([]); assert.equal(health.at(-1).ok, true); assert.equal(health.at(-1).issueCount, 0);
    await owner.disableTrafficObserver(); await assert.rejects(query(), /未启用/); assert.equal(socket.destroyed, false);
  } finally { socket.destroy(); await owner.close(); }
});
