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
import imageKit from '../kits/image-reference-dedup/index.mjs';
import createImageReferenceKitService from '../src/image-reference-kit-service.mjs';
import { createImageReferenceTransform } from '../src/image-reference-transform.mjs';
import { createTransformRouter } from '../src/transform-router.mjs';

test('image Kit updates through the manager with one transport and preserves the cache', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-image-kit-runtime-')); t.after(() => fs.rm(root, { recursive: true }));
  const packer = path.join(path.dirname(fileURLToPath(import.meta.resolve('codex-toolkit-core/kits'))), 'feature-pack.mjs');
  const entry = fileURLToPath(new URL('../kits/image-reference-dedup/index.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [packer, entry, root], { windowsHide: true, encoding: 'utf8' });
  const initial = JSON.parse(stdout).output, candidate = path.join(root, 'candidate'); await fs.mkdir(candidate);
  const manifest = { ...imageKit.manifest, version: '0.2.0' };
  await fs.writeFile(path.join(candidate, 'kit.json'), JSON.stringify(manifest), 'utf8');
  await fs.writeFile(path.join(candidate, 'index.mjs'), kitModule({ ...imageKit, manifest }), 'utf8');
  await fs.copyFile(path.join(initial, 'backend.mjs'), path.join(candidate, 'backend.mjs'));
  const cachePath = path.join(root, 'cache.json'); let uploads = 0, acquisitions = 0;
  const options = { cachePath, upload: async () => 'file_' + ++uploads }, router = createTransformRouter(await createImageReferenceTransform({ ...options, enabled: false }));
  const owner = { imageReferenceControl: () => ({ handedOff: true }), setImageReferenceTransform: factory => router.replace(() => factory(options)),
    disableImageReferenceTransform: () => router.replace(() => createImageReferenceTransform({ ...options, enabled: false })) };
  const client = { handlers: new Set(), closed: false, targets: () => [], async close() { this.closed = true; } };
  const stateDirectory = path.join(root, 'state'); await fs.mkdir(stateDirectory);
  const context = { stateDirectory, cdp: { acquire: async () => { acquisitions++; return client; }, onReconnect: () => () => {} }, getPlugin: id => id === 'bandwidth' ? owner : null,
    log: async () => {}, setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  const data = Buffer.from(JSON.stringify({ input: [{ type: 'message', content: [{ type: 'input_image', image_url: 'data:image/webp;base64,YQ==' }] }] }));
  const request = { path: '/backend-api/codex/responses', transport: 'websocket', headers: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture' } };
  assert.equal(await router.apply(data, request), data);
  const factory = Object.assign((...args) => createImageReferenceKitService(...args), { serviceApiVersion: '1.0.0' });
  const instance = await runtime({ artifacts: [initial], services: { 'image-reference': { module: 'unused' } } }, { serviceFactories: { 'image-reference': factory } }).start(context);
  try {
    await instance.connect(); const before = instance.snapshot();
    assert.equal(JSON.parse(await router.apply(data, request)).input[0].content[0].file_id, 'file_1');
    await instance.prepare('image-reference-dedup', candidate); await instance.restart();
    assert.equal(instance.snapshot().features[0].version, '0.2.0'); assert.notEqual(instance.snapshot().hostPid, before.hostPid);
    assert.equal(JSON.parse(await router.apply(data, request)).input[0].content[0].file_id, 'file_1'); assert.equal(uploads, 1); assert.equal(acquisitions, 1); assert.equal(client.closed, false);
  } finally { await instance.close(); }
  assert.equal(await router.apply(data, request), data);
});

test('image Kit requires an explicit legacy transport handoff', async () => {
  await assert.rejects(createImageReferenceKitService({}, { getPlugin: () => ({ imageReferenceControl: () => ({ handedOff: false }) }) }), /hand off/);
});

test('closing the image service releases its transient transform only once', async () => {
  let disabled = 0;
  const owner = { imageReferenceControl: () => ({ handedOff: true, backendPath: '/fixture/backend.mjs' }),
    setImageReferenceTransform() {}, async disableImageReferenceTransform() { disabled++; } };
  const service = await createImageReferenceKitService({}, { getPlugin: () => owner });
  await service.close(); await service.close();
  assert.equal(disabled, 1);
});

test('image reuse is ready before Codex connects and can be disabled while waiting', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-image-kit-before-cdp-')); t.after(() => fs.rm(root, { recursive: true }));
  const packer = path.join(path.dirname(fileURLToPath(import.meta.resolve('codex-toolkit-core/kits'))), 'feature-pack.mjs');
  const entry = fileURLToPath(new URL('../kits/image-reference-dedup/index.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [packer, entry, root], { windowsHide: true, encoding: 'utf8' });
  const directory = JSON.parse(stdout).output, cachePath = path.join(root, 'cache.json');
  const options = { cachePath, upload: async () => 'file_fixture' }, router = createTransformRouter(await createImageReferenceTransform({ ...options, enabled: false }));
  const owner = { imageReferenceControl: () => ({ handedOff: true }), setImageReferenceTransform: factory => router.replace(() => factory(options)),
    disableImageReferenceTransform: () => router.replace(() => createImageReferenceTransform({ ...options, enabled: false })) };
  const stateDirectory = path.join(root, 'state'); await fs.mkdir(stateDirectory);
  const context = { stateDirectory, cdp: { acquire: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), onReconnect: () => () => {} },
    getPlugin: id => id === 'bandwidth' ? owner : null, log: async () => {}, setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  const data = Buffer.from(JSON.stringify({ input: [{ type: 'message', content: [{ type: 'input_image', image_url: 'data:image/webp;base64,YQ==' }] }] }));
  const request = { path: '/backend-api/codex/responses', transport: 'websocket', headers: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture' } };
  const factory = Object.assign((...args) => createImageReferenceKitService(...args), { serviceApiVersion: '1.0.0' });
  const instance = await runtime({ artifacts: [directory], services: { 'image-reference': { module: 'unused', startBeforeCdp: true } } }, { serviceFactories: { 'image-reference': factory } }).start(context);
  try {
    assert.equal(instance.snapshot().phase, 'waiting-for-app');
    assert.equal(JSON.parse(await router.apply(data, request)).input[0].content[0].file_id, 'file_fixture');
    instance.select('image-reference-dedup', false); await instance.restart();
    assert.equal(await router.apply(data, request), data);
  } finally { await instance.close(); }
});
