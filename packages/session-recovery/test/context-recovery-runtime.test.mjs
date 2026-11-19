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
import contextKit from '../kits/context-recovery-integration/index.mjs';
import createContextRecoveryService from '../src/context-recovery-kit-service.mjs';
import { installRules, rulesStatus } from '../src/integration.mjs';

test('context recovery Kit updates its owned files and leaves thread-runtime protection when disabled', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-context-kit-')); t.after(() => fs.rm(root, { recursive: true }));
  const codexHome = path.join(root, 'codex'), stateDirectory = path.join(root, 'state'); await fs.mkdir(codexHome); await fs.mkdir(stateDirectory);
  const options = { codexHome, stateDirectory, powershell: process.execPath, nodeExecutable: process.execPath };
  const other = { matcher: 'view_image', hooks: [{ type: 'command', command: 'other' }] }, trust = { trusted: ['unrelated'] }, hooks = path.join(codexHome, 'hooks.json');
  await fs.writeFile(hooks, JSON.stringify({ hooks: { PreToolUse: [other], SessionStart: [] }, trust }), 'utf8');
  const previous = await installRules(options), runtimeSkill = previous.artifacts.find(row => row.filename.endsWith('codex-thread-runtime' + path.sep + 'SKILL.md')).filename, runtimeBefore = await fs.readFile(runtimeSkill, 'utf8');
  const packer = path.join(path.dirname(fileURLToPath(import.meta.resolve('codex-toolkit-core/kits'))), 'feature-pack.mjs');
  const entry = fileURLToPath(new URL('../kits/context-recovery-integration/index.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [packer, entry, root], { windowsHide: true, encoding: 'utf8' });
  const initial = JSON.parse(stdout).output, candidate = path.join(root, 'candidate'); await fs.cp(initial, candidate, { recursive: true });
  const manifest = { ...contextKit.manifest, version: '0.2.0' };
  await fs.writeFile(path.join(candidate, 'kit.json'), JSON.stringify(manifest), 'utf8'); await fs.writeFile(path.join(candidate, 'index.mjs'), kitModule({ ...contextKit, manifest }), 'utf8');
  await fs.appendFile(path.join(candidate, 'assets', 'context-recovery', 'SKILL.md'), '\nFixture update.\n', 'utf8');
  const client = { handlers: new Set(), closed: false, targets: () => [], async close() { this.closed = true; } }; let acquisitions = 0;
  const context = { stateDirectory: path.join(root, 'runtime'), cdp: { acquire: async () => { acquisitions++; client.closed = false; return client; }, onReconnect: () => () => {} },
    getPlugin: id => id === 'session' ? { rulesStateDirectory: stateDirectory } : null, log: async () => {}, setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  await fs.mkdir(context.stateDirectory);
  const factory = Object.assign((...args) => createContextRecoveryService(...args), { serviceApiVersion: '1.0.0' });
  const start = () => runtime({ artifacts: [initial], services: { 'context-recovery': { module: 'unused', options: { codexHome, powershell: process.execPath, nodeExecutable: process.execPath } } } }, { serviceFactories: { 'context-recovery': factory } }).start(context);
  let instance = await start();
  try {
    await instance.connect(); assert.equal((await rulesStatus(options)).installed, true); const first = instance.snapshot().hostPid;
    await instance.prepare('context-recovery-integration', candidate); await instance.restart();
    assert.equal(instance.snapshot().features[0].version, '0.2.0'); assert.notEqual(instance.snapshot().hostPid, first); assert.equal(acquisitions, 1); assert.equal(client.closed, false);
    const recovery = path.join(codexHome, 'skills', 'context-recovery', 'SKILL.md'); assert.match(await fs.readFile(recovery, 'utf8'), /Fixture update/);
    assert.equal(await fs.readFile(runtimeSkill, 'utf8'), runtimeBefore); assert.equal((await rulesStatus(options)).installed, true);
    const hooksBeforeStop = await fs.readFile(hooks), recoveryBeforeStop = await fs.readFile(recovery), receiptBeforeStop = await fs.readFile((await rulesStatus(options)).receiptFile);
    await instance.close(); instance = null;
    assert.deepEqual(await fs.readFile(hooks), hooksBeforeStop); assert.deepEqual(await fs.readFile(recovery), recoveryBeforeStop); assert.deepEqual(await fs.readFile((await rulesStatus(options)).receiptFile), receiptBeforeStop);
    instance = await start(); await instance.connect(); assert.equal((await rulesStatus(options)).installed, true);
    instance.select('context-recovery-integration', false); await instance.restart();
    const config = JSON.parse(await fs.readFile(hooks, 'utf8')); assert.deepEqual(config.hooks.PreToolUse, [other]); assert.deepEqual(config.hooks.SessionStart, []); assert.deepEqual(config.trust, trust);
    assert.equal(await fs.readFile(runtimeSkill, 'utf8'), runtimeBefore); assert.equal((await rulesStatus(options)).installed, false);
  } finally { await instance?.close(); }
});
