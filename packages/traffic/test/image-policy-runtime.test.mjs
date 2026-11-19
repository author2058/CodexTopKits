import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import runtime from 'codex-toolkit-core/kit-runtime';
import { kitModule } from 'codex-toolkit-core/kits';
import sharp from 'sharp';
import policyKit from '../kits/image-policy-rules/index.mjs';
import createImagePolicyKitService from '../src/image-policy-kit-service.mjs';
import { installImageIntegration, imageIntegrationStatus } from '../src/image-integration.mjs';
import { inspectFile } from '../src/image-delivery-audit.mjs';
import { bandwidthPlugin } from '../src/index.mjs';

test('image policy Kit updates its skill, Hook and matching checker without changing trust', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-image-policy-kit-')); t.after(() => fs.rm(root, { recursive: true }));
  const codexHome = path.join(root, 'codex'), stateDirectory = path.join(root, 'bandwidth'), runtimeDirectory = path.join(root, 'runtime');
  await fs.mkdir(codexHome); await fs.mkdir(stateDirectory); await fs.mkdir(runtimeDirectory);
  const other = { matcher: 'synthetic', hooks: [{ type: 'command', command: 'other' }] }, trust = { trusted: ['unrelated'] }, hooks = path.join(codexHome, 'hooks.json');
  await fs.writeFile(hooks, JSON.stringify({ hooks: { Stop: [other], PreToolUse: [] }, trust }), 'utf8');
  const options = { codexHome, stateDirectory, nodeExecutable: process.execPath }; await installImageIntegration(options);
  const packer = path.join(path.dirname(fileURLToPath(import.meta.resolve('codex-toolkit-core/kits'))), 'feature-pack.mjs');
  const entry = fileURLToPath(new URL('../kits/image-policy-rules/index.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [packer, entry, root], { windowsHide: true, encoding: 'utf8' });
  const initial = JSON.parse(stdout).output, candidate = path.join(root, 'candidate'); await fs.cp(initial, candidate, { recursive: true });
  const manifest = { ...policyKit.manifest, version: '0.2.0' };
  await fs.writeFile(path.join(candidate, 'kit.json'), JSON.stringify(manifest), 'utf8'); await fs.writeFile(path.join(candidate, 'index.mjs'), kitModule({ ...policyKit, manifest }), 'utf8');
  await fs.appendFile(path.join(candidate, 'assets', 'image-skill.md'), '\nFixture update.\n', 'utf8');
  const adapters = [], owner = { imagePolicyControl: () => ({ handedOff: true, stateDirectory }), async setImagePolicyChecker(value, install) { await install(); adapters.push(value); }, async resetImagePolicyChecker(remove) { await remove(); adapters.push(null); } };
  const client = { handlers: new Set(), closed: false, targets: () => [], async close() { this.closed = true; } }; let acquisitions = 0;
  const context = { stateDirectory: runtimeDirectory, cdp: { acquire: async () => { acquisitions++; client.closed = false; return client; }, onReconnect: () => () => {} },
    getPlugin: id => id === 'bandwidth' ? owner : null, log: async () => {}, setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  const factory = Object.assign((...args) => createImagePolicyKitService(...args), { serviceApiVersion: '1.0.0' });
  const start = () => runtime({ artifacts: [initial], services: { 'image-policy': { module: 'unused', options: { codexHome, nodeExecutable: process.execPath } } } }, { serviceFactories: { 'image-policy': factory } }).start(context);
  let instance = await start();
  try {
    await instance.connect(); assert.equal((await imageIntegrationStatus(options)).installed, true);
    const trustedHook = JSON.parse(await fs.readFile(hooks, 'utf8')).hooks.PreToolUse[0];
    const firstChecker = await import(pathToFileURL(path.join(initial, 'src', 'check-codex-image-policy.mjs')).href); assert.equal(adapters.at(-1).checkCodexImagePolicy, firstChecker.checkCodexImagePolicy);
    const source = path.join(root, 'input.png'); await sharp({ create: { width: 64, height: 32, channels: 3, background: '#315b86' } }).png().toFile(source);
    const before = await fs.readFile(source), assetScript = path.join(initial, 'src', 'prepare-model-image.mjs'), sharpEntry = createRequire(import.meta.url).resolve('sharp');
    const result = await promisify(execFile)(process.execPath, [assetScript, '--sharp-entry', sharpEntry, '--project', root, source], { windowsHide: true, encoding: 'utf8' });
    const output = JSON.parse(result.stdout), image = await inspectFile(output.path); assert.equal(image.format, 'webp'); assert.equal(image.compression, 'lossy'); assert.equal(output.quality, 85); assert.deepEqual(await fs.readFile(source), before);
    const first = instance.snapshot().hostPid; await instance.prepare('image-policy-rules', candidate); await instance.restart();
    assert.equal(instance.snapshot().features[0].version, '0.2.0'); assert.notEqual(instance.snapshot().hostPid, first); assert.equal(acquisitions, 1); assert.equal(client.closed, false);
    const status = await imageIntegrationStatus(options); assert.equal(status.installed, true); assert.equal(status.trust, 'not-checked'); assert.match(await fs.readFile(status.skillFile, 'utf8'), /Fixture update/);
    assert.deepEqual(JSON.parse(await fs.readFile(hooks, 'utf8')).hooks.PreToolUse[0], trustedHook);
    const updatedChecker = await import(pathToFileURL(path.join(runtimeDirectory, 'artifacts', 'image-policy-rules', '0.2.0', 'src', 'check-codex-image-policy.mjs')).href);
    assert.equal(adapters.length, 2); assert.equal(adapters[1].checkCodexImagePolicy, updatedChecker.checkCodexImagePolicy);
    const hooksBeforeStop = await fs.readFile(hooks), skillBeforeStop = await fs.readFile(status.skillFile), receiptBeforeStop = await fs.readFile(status.receiptFile);
    await instance.close(); instance = null;
    assert.deepEqual(await fs.readFile(hooks), hooksBeforeStop); assert.deepEqual(await fs.readFile(status.skillFile), skillBeforeStop); assert.deepEqual(await fs.readFile(status.receiptFile), receiptBeforeStop);
    instance = await start(); await instance.connect(); assert.equal((await imageIntegrationStatus(options)).installed, true);
    instance.select('image-policy-rules', false); await instance.restart();
    const config = JSON.parse(await fs.readFile(hooks, 'utf8')); assert.deepEqual(config.hooks.Stop, [other]); assert.deepEqual(config.hooks.PreToolUse, []); assert.deepEqual(config.trust, trust);
    assert.equal((await imageIntegrationStatus(options)).installed, false); assert.equal(adapters.at(-1), null);
  } finally { await instance?.close(); }
});

test('Bandwidth switches the actual policy watcher without contacting the model service', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-policy-owner-')); t.after(() => fs.rm(stateDirectory, { recursive: true }));
  const health = [], owner = await bandwidthPlugin({ externalKits: ['image-policy-rules'] }).start({ stateDirectory, setHealth: value => health.push(value), log: async () => {} });
  try {
    let installs = 0, checks = 0;
    const adapter = { discoverDesktopCodex: async () => ({ executable: 'fixture' }), checkCodexImagePolicy: async () => { checks++; return { ok: true, cached: false, version: 'fixture', policyId: 'new-policy', failures: [] }; } };
    await owner.setImagePolicyChecker(adapter, async () => { installs++; }); assert.equal(installs, 1);
    assert.equal((await owner.check()).policyId, 'new-policy'); assert.equal(checks, 1);
    const failure = new Error('fixture rule installation failed'); await assert.rejects(owner.setImagePolicyChecker(adapter, async () => { throw failure; }), error => error === failure);
    assert.ok(health.some(value => !value.ok && value.message.includes(failure.message)));
    const failed = health.findLast(value => !value.ok);
    assert.match(failed.messageLocales.en, /Native image-policy check failed: fixture rule installation failed/);
    assert.match(failed.messageLocales['zh-Hans'], /原生图片规则检查失败：fixture rule installation failed/);
    await owner.resetImagePolicyChecker(async () => { installs++; }); assert.equal(installs, 2); assert.equal(health.at(-1).ok, true);
    assert.match(health.at(-1).messageLocales['zh-Hans'], /本地转发已就绪/);
  } finally { await owner.close(); }
});
