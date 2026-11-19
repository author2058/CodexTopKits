import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { kitModule } from 'codex-toolkit-core/kits';
import kitRuntime from 'codex-toolkit-core/kit-runtime';
import fontKit from '../kits/ui-font-size/index.mjs';
import colorKit from '../kits/project-thread-colors/index.mjs';
import themesPlugin from '../src/index.mjs';
import createThemeSettingsService from '../src/feature-service.mjs';

async function start(t, acquire) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-themes-plugin-')), logs = [], health = [];
  const plugin = await themesPlugin({ cdpPort: 12345 }).start({ stateDirectory: directory, log: async value => { logs.push(value); }, setHealth: value => health.push(value), cdp: { port: 12345, acquire, onReconnect: () => () => {} } });
  t.after(async () => { await plugin.close(); await fs.rm(directory, { recursive: true }); });
  const request = (pathname, body) => plugin.management.request({ method: body === undefined ? 'GET' : 'POST', url: new URL(pathname, 'http://127.0.0.1'), body });
  return { plugin, request, logs, health };
}

test('Themes is ready before app startup and owned cancellation releases a pending connection', async t => {
  let cancelled = false;
  const { plugin, request, health } = await start(t, ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true });
  }));
  assert.match((await request('/')).body, /Codex theme manager/);
  assert.equal(health.at(-1).ok, true);
  await plugin.close();
  assert.equal(cancelled, true);
});

test('management page edits are read on navigation without restarting the Themes owner', async t => {
  const original = fs.readFile;
  let page = '<title>First theme page</title>';
  t.mock.method(fs, 'readFile', (filename, ...options) => filename instanceof URL && filename.pathname.endsWith('/assets/theme-manager.html')
    ? Promise.resolve(page) : original(filename, ...options));
  const { request, health } = await start(t, ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  assert.equal((await request('/')).body, page);
  page = '<title>Updated theme page</title>';
  assert.equal((await request('/')).body, page);
  assert.equal(health.at(-1).ok, true);
});

test('the management page and renderer reports use one assignment resolver and event subscription', async t => {
  const client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'main', type: 'page', url: 'app://codex/' }],
    async send(method) {
      if (method === 'Target.attachToTarget') return { sessionId: 'main-session' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'fixture-script' };
      if (method === 'Runtime.evaluate') return { result: { value: {} } };
      return {};
    },
    async close() { this.closed = true; },
  };
  const { request, health, logs } = await start(t, async () => client);
  await new Promise(resolve => setImmediate(resolve));
  for (const handler of client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'main-session', params: { name: '__CDTK_THEMES_REPORT__', payload: JSON.stringify({ applicable: true,
    context: { taskKey: 'local:one', projectName: 'Beta' }, errors: [], catalog: { projects: [{ name: 'Beta', rootPaths: ['S:/fixtures/Beta'] }], tasks: [{ taskKey: 'local:one', title: 'First', projectName: 'Beta' }] } }) } });
  const updates = [], stream = await request('/api/events'), unsubscribe = stream.subscribe(value => updates.push(value));
  const changed = await request('/api/assignment', { kind: 'project', key: 'Beta', value: 'blue' });
  assert.equal(changed.body.catalog.tasks[0].themeId, 'blue');
  assert.equal(changed.body.catalog.projects[0].themeId, 'blue');
  assert.equal(changed.body.catalog.tasks[0].taskAssignment, 'inherit');
  assert.equal(updates.at(-1).catalog.tasks[0].theme.accent, '#4f8fe8');
  const channels = { accent: false, canvas: true, surface: false, sidebar: true };
  assert.deepEqual((await request('/api/appearance', { enabledColors: channels, uiFontSizeOverride: 20 })).body.map.enabledColors, channels);
  await assert.rejects(request('/api/assignment', { kind: 'project', key: 'Beta', value: 'unknown' }), error => error.status === 400);
  assert.equal(health.at(-1).ok, true); assert.equal(logs.length, 0);
  unsubscribe();
});

test('a font Kit reuses the existing theme settings owner and receives only font changes', async t => {
  const { plugin, request } = await start(t, ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  let notifications = 0; const errors = [];
  const service = await createThemeSettingsService({ legacyPlugin: 'themes' }, { getPlugin: id => id === 'themes' ? plugin : null,
    notify: async () => { notifications++; }, reportError: error => errors.push(error) });
  t.after(() => service.close());
  assert.equal(service.snapshot().themeSettings.uiFontSizeOverride, null);
  await request('/api/assignment', { kind: 'project', key: 'Example', value: 'blue' });
  assert.equal(notifications, 0);
  const enabledColors = { accent: true, canvas: true, surface: true, sidebar: true };
  await request('/api/appearance', { enabledColors, uiFontSizeOverride: 20 });
  assert.equal(service.snapshot().themeSettings.uiFontSizeOverride, 20); assert.equal(notifications, 1); assert.deepEqual(errors, []);
  service.close();
  await request('/api/appearance', { enabledColors, uiFontSizeOverride: 18 });
  assert.equal(notifications, 1);
});

test('project colors receive the shared map and font-only mode does not broadcast unrelated changes', async t => {
  const { plugin, request } = await start(t, ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  let notifications = 0;
  const service = await createThemeSettingsService({ legacyPlugin: 'themes', enabled: ['project-thread-colors'] }, { getPlugin: () => plugin,
    notify: async () => { notifications++; }, reportError() {} });
  t.after(() => service.close());
  await request('/api/assignment', { kind: 'project', key: 'Example', value: 'blue' });
  assert.equal(service.snapshot().themeSettings.map.projects.Example, 'blue'); assert.equal(notifications, 1);
  service.configure(['ui-font-size']); assert.equal('map' in service.snapshot().themeSettings, false);
  await request('/api/assignment', { kind: 'project', key: 'Example', value: 'red' });
  assert.equal(notifications, 1);
});

test('standalone theme settings follow changes to their configured file', { timeout: 5000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-theme-service-')), filename = path.join(directory, 'map.json');
  let changed; const observed = new Promise(resolve => { changed = resolve; }); const errors = [];
  const service = await createThemeSettingsService({ mapPath: filename }, { stateDirectory: directory, notify: async () => changed(), reportError: error => { if (error) errors.push(error); } });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true }); });
  const map = JSON.parse(await fs.readFile(filename, 'utf8')); map.uiFontSizeOverride = 20;
  await fs.writeFile(filename, JSON.stringify(map), 'utf8'); await observed;
  assert.equal(service.snapshot().themeSettings.uiFontSizeOverride, 20); assert.deepEqual(errors, []);
});

test('the Kit runtime delivers live legacy font settings to renderer pages', async t => {
  const { plugin, request } = await start(t, ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-font-runtime-')), artifact = path.join(directory, 'artifact'), colorsArtifact = path.join(directory, 'colors');
  await fs.mkdir(artifact); await fs.writeFile(path.join(artifact, 'kit.json'), JSON.stringify(fontKit.manifest), 'utf8');
  await fs.writeFile(path.join(artifact, 'index.mjs'), kitModule(fontKit), 'utf8');
  await fs.mkdir(colorsArtifact); await fs.writeFile(path.join(colorsArtifact, 'kit.json'), JSON.stringify(colorKit.manifest), 'utf8');
  await fs.writeFile(path.join(colorsArtifact, 'index.mjs'), kitModule(colorKit), 'utf8');
  const expressions = [], client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'page', type: 'page', url: 'app://index.html' }],
    async send(method, params) {
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
      if (method === 'Runtime.evaluate') { expressions.push(params.expression); return { result: { value: true } }; }
      return {};
    }, async close() { this.closed = true; } };
  const context = { stateDirectory: directory, getPlugin: id => id === 'themes' ? plugin : null,
    cdp: { acquire: async () => client, onReconnect: () => () => {} }, log: async () => {}, setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  const runtime = await kitRuntime({ artifacts: [artifact, colorsArtifact], services: { 'theme-settings': { module: 'codex-toolkit-themes/feature-service', options: { legacyPlugin: 'themes' } } } }).start(context);
  try {
    await runtime.connect(); expressions.length = 0;
    await request('/api/appearance', { enabledColors: { accent: true, canvas: true, surface: true, sidebar: true }, uiFontSizeOverride: 20 });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(expressions.some(value => value.includes('setRuntimeState(') && value.includes('"uiFontSizeOverride":20')));
    expressions.length = 0;
    await request('/api/assignment', { kind: 'project', key: 'Example', value: 'blue' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(expressions.some(value => value.includes('setRuntimeState(') && value.includes('"Example":"blue"')));
  } finally { await runtime.close(); await fs.rm(directory, { recursive: true }); }
});
