import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import runtime from 'codex-toolkit-core/kit-runtime';
import { kitModule } from 'codex-toolkit-core/kits';
import awakeKit from '../kits/awake-bridge/index.mjs';
import createAwakeService, { serviceApiVersion as awakeServiceApiVersion } from '../src/awake-service.mjs';

test('the actual Awake artifact updates through the Kit manager without closing CDP', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-awake-runtime-')); t.after(() => fs.rm(root, { recursive: true }));
  const packer = path.join(path.dirname(fileURLToPath(import.meta.resolve('codex-toolkit-core/kits'))), 'feature-pack.mjs');
  const entry = fileURLToPath(new URL('../kits/awake-bridge/index.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [packer, entry, root], { windowsHide: true, encoding: 'utf8' });
  const initial = JSON.parse(stdout).output, candidate = path.join(root, 'candidate'); await fs.mkdir(candidate);
  const manifest = { ...awakeKit.manifest, version: '0.2.0' };
  await fs.writeFile(path.join(candidate, 'kit.json'), JSON.stringify(manifest), 'utf8');
  await fs.writeFile(path.join(candidate, 'index.mjs'), kitModule({ ...awakeKit, manifest }), 'utf8');
  await fs.copyFile(path.join(initial, 'backend.mjs'), path.join(candidate, 'backend.mjs'));
  for (const name of manifest.assets) {
    await fs.mkdir(path.dirname(path.join(candidate, name)), { recursive: true });
    await fs.copyFile(path.join(initial, name), path.join(candidate, name));
  }
  const writes = [], writerPaths = [], handlers = new Set(); let acquisitions = 0;
  const client = { handlers, closed: false, targets: () => [{ targetId: 'one', type: 'page', url: 'app://index.html' }],
    async send(method, params) {
      if (method === 'Target.attachToTarget') return { sessionId: 'page-one' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
      if (method === 'Runtime.evaluate' && params.expression.includes('readActivity')) return { result: { value: { loadedThreadIds: ['one'], busyThreadIds: [] } } };
      if (method === 'Runtime.evaluate') return { result: { value: true } }; return {};
    }, async close() { this.closed = true; } };
  const stateDirectory = path.join(root, 'state'); await fs.mkdir(stateDirectory);
  const context = { stateDirectory, cdp: { acquire: async () => { acquisitions++; return client; }, onReconnect: () => () => {} },
    log: async () => {}, setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  const windows = async () => ({ snapshot: () => ({}), configure() {}, receive: (_target, value) => value.kind === 'window-state' || value.kind === 'window-activity', removeTarget() {}, close() {} });
  const serviceFactories = { windows: Object.assign(windows, { serviceApiVersion: '1.0.0' }), awake: Object.assign((options, serviceContext) => createAwakeService(options, serviceContext, { writeAwakeBatch: async (_shell, script, batch, state) => { writes.push(batch); writerPaths.push({ script, state }); } }), { serviceApiVersion: awakeServiceApiVersion }) };
  const oldAwake = Object.assign(async () => { throw new Error('Old service must not start'); }, { serviceApiVersion: '1.0.0' });
  await assert.rejects(runtime({ artifacts: [initial], services: { windows: { module: 'unused' }, awake: { module: 'unused' } } }, { serviceFactories: { ...serviceFactories, awake: oldAwake } }).start(context), /requires awake service API \^1\.1\.0/);
  const instance = await runtime({ artifacts: [initial], services: { windows: { module: 'unused' }, awake: { module: 'unused' } } }, { serviceFactories }).start(context);
  t.after(() => instance.close()); await instance.connect();
  const emit = value => Promise.all([...handlers].map(handler => handler({ method: 'Runtime.bindingCalled', sessionId: 'page-one', params: { name: '__CODEXTOPKITS_FEATURE_ACTION__', payload: JSON.stringify(value) } })));
  await emit({ kind: 'window-state', applicable: true });
  for (let i = 0; i < 100 && !writes.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(writes.length); const before = instance.snapshot();
  assert.equal(writerPaths[0].script, path.join(initial, 'codex-awake', 'Update-CodexAwakeState.ps1'));
  assert.equal(writerPaths[0].state, path.join(stateDirectory, 'services', 'awake'));
  await instance.prepare('awake-bridge', candidate); await instance.restart();
  assert.equal(instance.snapshot().features[0].version, '0.2.0'); assert.notEqual(instance.snapshot().hostPid, before.hostPid);
  assert.equal(acquisitions, 1); assert.equal(client.closed, false);
  await emit({ kind: 'window-activity', hostId: 'local', method: 'turn/completed', params: { threadId: 'one', turnId: 'done', turnStatus: 'failed' } });
  for (let i = 0; i < 100 && !writes.some(batch => batch.events.some(event => event.outcome === 'failed')); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(writes.some(batch => batch.events.some(event => event.outcome === 'failed')));
});
