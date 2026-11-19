import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { kitModule } from 'codex-toolkit-core/kits';
import kitRuntime from 'codex-toolkit-core/kit-runtime';
import kit from '../kits/markdown-edge-read-aloud/index.mjs';
import { launchReadAloud } from '../src/read-aloud.mjs';
import createReadAloudService from '../src/read-aloud-service.mjs';

test('Markdown launch preserves the verified native script, literal path, Unicode and playback readback', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-read-aloud-')); t.after(() => fs.rm(root, { recursive: true }));
  const file = path.join(root, '文件 [one].md'); await fs.writeFile(file, '# Fixture', 'utf8');
  const calls = [], execute = async (...args) => { calls.push(args); return { stdout: JSON.stringify({ started: true, foregroundConfirmed: true, processId: 123 }) }; };
  assert.equal((await launchReadAloud(file, null, 'pwsh', execute)).processId, 123);
  assert.ok(calls[0][1].some(value => value.endsWith('open-markdown-in-edge-read-aloud.ps1'))); assert.equal(calls[0][1].at(-1), file);
  assert.equal(calls[0][2].encoding, 'utf8'); assert.equal(calls[0][2].windowsHide, true);
  assert.equal((await launchReadAloud(path.basename(file), root, 'pwsh', execute)).started, true);
  await assert.rejects(launchReadAloud(file, null, 'pwsh', async () => ({ stdout: '{"started":true}' })), /未确认/);
  const original = new Error('Edge rejected foreground'); await assert.rejects(launchReadAloud(file, null, 'pwsh', async () => { throw original; }), error => error === original);
});

test('read-aloud rejects non-Markdown and ambiguous relative paths before starting a program', async () => {
  let calls = 0; const execute = async () => { calls++; };
  await assert.rejects(launchReadAloud('file.txt', null, 'pwsh', execute), /Markdown/);
  await assert.rejects(launchReadAloud('file.md', null, 'pwsh', execute), /完整路径/); assert.equal(calls, 0);
});

test('the Kit service forwards only explicit Markdown actions to the existing launcher', async () => {
  const calls = [], logs = [], original = new Error('Native Edge failure');
  const service = await createReadAloudService({ powershellPath: 'pwsh' }, { log: async value => logs.push(value) }, {
    launchReadAloud: async (...args) => { calls.push(args); if (args[0] === 'bad.md') throw original; return { started: true, foregroundConfirmed: true }; },
  });
  assert.equal(await service.receive('target', { kind: 'other' }), false);
  assert.equal(await service.receive('target', { kind: 'read-aloud', path: 'doc.md', cwd: 'C:/fixture' }), true);
  assert.deepEqual(calls[0], ['doc.md', 'C:/fixture', 'pwsh']);
  assert.deepEqual(logs[0], { event: 'read-aloud-started', targetId: 'target', started: true, foregroundConfirmed: true });
  await assert.rejects(service.receive('target', { kind: 'read-aloud', path: 'bad.md', cwd: null }), error => error === original);
  service.close();
});

test('the Kit runtime routes a read-aloud action to the shared service without starting Edge', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-read-aloud-kit-')), artifact = path.join(root, 'artifact');
  await fs.mkdir(artifact); await fs.writeFile(path.join(artifact, 'kit.json'), JSON.stringify(kit.manifest), 'utf8');
  await fs.writeFile(path.join(artifact, 'index.mjs'), kitModule(kit), 'utf8');
  const calls = [], logs = [], client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'page', type: 'page', url: 'app://index.html' }],
    async send(method) { if (method === 'Target.attachToTarget') return { sessionId: 'session' }; if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' }; if (method === 'Runtime.evaluate') return { result: { value: true } }; return {}; },
    async close() { this.closed = true; } };
  const context = { stateDirectory: root, cdp: { acquire: async () => client, onReconnect: () => () => {} }, log: async value => logs.push(value),
    setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  const serviceFactories = { 'read-aloud': Object.assign((options, inner) => createReadAloudService(options, inner, { launchReadAloud: async (...args) => { calls.push(args); return { started: true, foregroundConfirmed: true }; } }), { serviceApiVersion: '1.0.0' }) };
  const runtime = await kitRuntime({ artifacts: [artifact], services: { 'read-aloud': { module: 'codex-toolkit-windows/read-aloud-service', options: { powershellPath: 'pwsh' } } } }, { serviceFactories }).start(context);
  try {
    await runtime.connect();
    for (const handler of client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'session', params: {
      name: '__CODEXTOPKITS_FEATURE_ACTION__', payload: JSON.stringify({ kind: 'read-aloud', path: 'doc.md', cwd: 'C:/fixture' }),
    } });
    assert.deepEqual(calls, [['doc.md', 'C:/fixture', 'pwsh']]);
    assert.ok(logs.some(value => value.event === 'read-aloud-started' && value.targetId === 'page'));
  } finally { await runtime.close(); await fs.rm(root, { recursive: true }); }
});
