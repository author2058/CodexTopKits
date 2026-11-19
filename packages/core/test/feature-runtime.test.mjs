import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import featureRuntimePlugin, { readKitArtifact } from '../src/feature-runtime.mjs';
import { featureModule } from '../src/features.mjs';
import { createKitBundle } from '../src/kit-bundle.mjs';
import { featureDom } from './support/feature-dom.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-feature-runtime-')); t.after(() => fs.rm(root, { recursive: true }));
  const artifact = async (id, version, dependencies = {}, create = () => ({ close() {} }), options = {}) => {
    const directory = path.join(root, id + '-' + version), manifest = { id, version, entry: 'index.mjs', coreApiVersion: 1, dependencies, ...options };
    await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'kit.json'), JSON.stringify(manifest), 'utf8');
    await fs.writeFile(path.join(directory, 'index.mjs'), featureModule({ manifest, create }), 'utf8'); return directory;
  };
  const calls = [], health = [], logs = [], stateDirectory = path.join(root, 'state'); await fs.mkdir(stateDirectory);
  let acquisitions = 0, reconnect;
  const client = { handlers: new Set(), closed: false, targets: () => [{ targetId: 'one', type: 'page', url: 'app://index.html' }],
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.attachToTarget') return { sessionId: 'session-one' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-' + calls.length };
      if (method === 'Runtime.evaluate') return { result: { value: true } }; return {};
    }, async close() { this.closed = true; },
  };
  const context = { stateDirectory, cdp: { acquire: async () => { acquisitions++; client.closed = false; return client; }, onReconnect: callback => { reconnect = callback; return () => {}; } },
    log: async value => logs.push(value), setHealth: value => health.push(value), onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  return { root, artifact, context, client, calls, health, logs, reconnect: () => reconnect(), get acquisitions() { return acquisitions; } };
}

test('duplicate configured Kit identities fail before acquiring CDP or starting a host', async t => {
  const f = await fixture(t), first = await f.artifact('app-restart', '0.1.0'), second = await f.artifact('app-restart', '0.1.1');
  await assert.rejects(featureRuntimePlugin({ artifacts: [first, second] }).start(f.context), /Duplicate installed feature ID: app-restart/);
  assert.equal(f.acquisitions, 0); assert.equal(f.calls.length, 0);
});

test('native host language and appearance reports reach Core without restarting Kits or invoking a provider action', async t => {
  const f = await fixture(t), artifact = await f.artifact('sample', '0.1.0'), languages = [], appearances = [];
  const instance = await featureRuntimePlugin({ artifacts: [artifact] }).start({ ...f.context, setHostLanguage: language => languages.push(language), setHostAppearance: value => appearances.push(value) });
  t.after(() => instance.close()); await instance.connect();
  const pid = instance.snapshot().hostPid;
  for (const handler of f.client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'session-one', params: {
    name: '__CODEXTOPKITS_FEATURE_ACTION__', payload: JSON.stringify({ kind: 'host-language', language: 'en-US' }),
  } });
  assert.deepEqual(languages, ['en-US']); assert.equal(instance.snapshot().hostPid, pid); assert.equal(f.client.closed, false);
  for (const handler of f.client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'session-one', params: {
    name: '__CODEXTOPKITS_FEATURE_ACTION__', payload: JSON.stringify({ kind: 'host-appearance', appearance: 'light' }),
  } });
  assert.deepEqual(appearances, ['light']); assert.equal(instance.snapshot().hostPid, pid); assert.equal(f.client.closed, false);
});

test('late renderer errors and recovery reach the same page and aggregate health through the native binding', async t => {
  const f = await fixture(t), dom = featureDom(), { document } = dom;
  const directory = await f.artifact('async-health', '0.1.0', {}, ({ document, reportError }) => {
    document.defaultView.reportFixtureHealth = error => reportError(error, 'native');
    return { close() { delete document.defaultView.reportFixtureHealth; } };
  });
  let bindingWork = Promise.resolve();
  const page = { __CODEXTOPKITS_FEATURE_ACTION__(payload) {
    bindingWork = bindingWork.then(async () => { for (const handler of f.client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'session-one', params: { name: '__CODEXTOPKITS_FEATURE_ACTION__', payload, executionContextId: 11 } }); });
  } };
  const realm = vm.createContext({ document, window: page }), send = f.client.send;
  f.client.send = async function(method, params, sessionId) {
    if (method === 'Runtime.evaluate') return { result: { value: await vm.runInContext(params.expression, realm) } };
    return send.call(this, method, params, sessionId);
  };
  const instance = await featureRuntimePlugin({ artifacts: [directory] }).start(f.context); t.after(() => instance.close());
  await instance.connect(); await bindingWork;
  document.defaultView.reportFixtureHealth(new Error('Fixture late native error.')); await bindingWork;
  assert.equal(instance.snapshot().pages[0].features[0].errors[0].message, 'Fixture late native error.');
  assert.equal(instance.snapshot().errors.length, 1); assert.equal(f.health.at(-1).issueCount, 1);
  assert.equal(f.health.at(-1).recoverable, false, 'Kit failures cannot be healed by reconnecting the host');
  assert.equal(f.logs.at(-1).event, 'kit-health-changed'); assert.equal(f.logs.at(-1).issueCount, 1);
  assert.equal(f.logs.at(-1).executionContextId, 11);
  document.defaultView.reportFixtureHealth(null); await bindingWork;
  assert.deepEqual(instance.snapshot().pages[0].features[0].errors, []);
  assert.deepEqual(instance.snapshot().errors, []); assert.equal(f.health.at(-1).ok, true); assert.equal(f.health.at(-1).issueCount, 0);
  assert.equal(f.logs.at(-1).event, 'kit-health-changed'); assert.equal(f.logs.at(-1).issueCount, 0);
});

test('a reloaded document receives the current preference even when its host language is unchanged', async t => {
  const f = await fixture(t), directory = await f.artifact('localized', '0.1.0', {}, ({ document, i18n }) => {
    const render = () => document.body.setAttribute('data-fixture-locale', i18n.locale);
    const unsubscribe = i18n.onChange(render); render(); return { close: unsubscribe };
  });
  let state = { languagePreference: { mode: 'auto' }, hostLanguage: 'en-US', systemLanguage: 'zh-CN', health: { plugins: [] } }, emitState, realm, bindingWork = Promise.resolve();
  const instance = await featureRuntimePlugin({ artifacts: [directory] }).start({ ...f.context,
    onHostState(listener) { emitState = listener; listener(state); return () => {}; },
    setHostLanguage() { return false; },
  });
  t.after(() => instance.close()); await instance.connect();
  const bootstrap = f.calls.find(call => call.method === 'Page.addScriptToEvaluateOnNewDocument').params.source;
  const send = f.client.send;
  f.client.send = async function(method, params, sessionId) {
    if (realm && method === 'Runtime.evaluate' && params.expression.includes('?.setHostState(')) return { result: { value: vm.runInContext(params.expression, realm) } };
    return send.call(this, method, params, sessionId);
  };
  const loadDocument = async () => {
    const fixture = featureDom(), { document } = fixture;
    document.documentElement.setAttribute('lang', 'en-US');
    const page = { __CODEXTOPKITS_FEATURE_ACTION__(payload) {
      bindingWork = bindingWork.then(async () => { for (const handler of f.client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'session-one', params: { name: '__CODEXTOPKITS_FEATURE_ACTION__', payload } }); });
    } };
    realm = vm.createContext({ document, window: page });
    await vm.runInContext(bootstrap, realm); await bindingWork;
    return { ...fixture, page };
  };
  const first = await loadDocument();
  assert.equal(first.document.body.getAttribute('data-fixture-locale'), 'en');
  state = { ...state, languagePreference: { mode: 'fixed', locale: 'zh-Hans' } }; emitState(state);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.document.body.getAttribute('data-fixture-locale'), 'zh-Hans');
  await first.page.__CODEXTOPKITS_FEATURE_HOST__.close();
  const second = await loadDocument();
  assert.equal(second.document.body.getAttribute('data-fixture-locale'), 'zh-Hans');
  await second.page.__CODEXTOPKITS_FEATURE_HOST__.close(); assert.equal(second.observers.size, 0);
});

test('opt-in Kits start disabled and retain explicit enabled choices across host restarts', async t => {
  const f = await fixture(t), normal = await f.artifact('normal', '0.1.0');
  const optional = await f.artifact('optional', '0.1.0', {}, undefined, { defaultEnabled: false });
  const options = { artifacts: [normal, optional] };
  let instance = await featureRuntimePlugin(options).start(f.context); t.after(() => instance.close());
  assert.deepEqual(instance.snapshot().features.map(({ id, enabled }) => ({ id, enabled })), [{ id: 'normal', enabled: true }, { id: 'optional', enabled: false }]);
  instance.select('optional', true); await instance.restart(); await instance.close();
  instance = await featureRuntimePlugin(options).start(f.context);
  assert.equal(instance.snapshot().features.find(row => row.id === 'optional').enabled, true);
  const update = await f.artifact('optional', '0.2.0', {}, undefined, { defaultEnabled: false });
  await instance.prepare('optional', update); await instance.restart();
  assert.equal(instance.snapshot().features.find(row => row.id === 'optional').enabled, true);
});

test('explicit configuration can enable an opt-in Kit and explicit installs respect its default', async t => {
  const f = await fixture(t), normal = await f.artifact('normal', '0.1.0');
  const optional = await f.artifact('optional', '0.1.0', {}, undefined, { defaultEnabled: false });
  const explicit = await featureRuntimePlugin({ artifacts: [optional], enabled: ['optional'] }).start(f.context);
  assert.equal(explicit.snapshot().features[0].enabled, true); await explicit.close();
  const stateDirectory = path.join(f.root, 'install-state'); await fs.mkdir(stateDirectory);
  const instance = await featureRuntimePlugin({ artifacts: [normal], enabled: ['normal'] }).start({ ...f.context, stateDirectory });
  t.after(() => instance.close());
  await instance.prepareInstall(optional); await instance.restart();
  const row = instance.snapshot().features.find(row => row.id === 'optional');
  assert.equal(row.installed, true); assert.equal(row.enabled, false);
  instance.select('optional', true); await instance.restart();
  assert.equal(instance.snapshot().features.find(row => row.id === 'optional').enabled, true);
});

test('recovery retries failed page initialization and preserves the running Kit host and prepared selection', async t => {
  const f = await fixture(t), directory = await f.artifact('sample', '0.1.0'), candidate = await f.artifact('sample', '0.2.0');
  const send = f.client.send, original = Object.assign(new Error('CDP command timed out: Runtime.enable'), { code: 'CDP_COMMAND_TIMEOUT' });
  let failing = true;
  f.client.send = async function(method, ...args) { if (failing && method === 'Runtime.enable') throw original; return send.call(this, method, ...args); };
  const instance = await featureRuntimePlugin({ artifacts: [directory] }).start(f.context);
  t.after(() => instance.close());
  await assert.rejects(instance.connect(), error => error === original);
  assert.equal(instance.snapshot().pages.length, 0);
  const pid = instance.snapshot().hostPid;
  await instance.prepare('sample', candidate);
  failing = false; await instance.check();
  assert.deepEqual(instance.snapshot().errors, []);
  assert.equal(instance.snapshot().pages.length, 1);
  assert.equal(instance.snapshot().hostPid, pid);
  assert.equal(instance.snapshot().features[0].version, '0.1.0');
  assert.equal(instance.snapshot().features[0].prepared.version, '0.2.0');
  const scripts = f.calls.filter(value => value.method === 'Page.addScriptToEvaluateOnNewDocument').length;
  await instance.check();
  assert.equal(f.calls.filter(value => value.method === 'Page.addScriptToEvaluateOnNewDocument').length, scripts, 'checking does not reinstall healthy Kits');
});

test('legacy artifacts remain readable, but an invalid kit manifest is not hidden', async t => {
  const f = await fixture(t), directory = await f.artifact('footer', '0.1.0');
  await fs.rename(path.join(directory, 'kit.json'), path.join(directory, 'plugin.json'));
  assert.equal((await readKitArtifact(directory)).manifestFile, 'plugin.json');
  const instance = await featureRuntimePlugin({ artifacts: [directory] }).start(f.context);
  t.after(() => instance.close());
  const candidate = await f.artifact('footer', '0.1.1');
  await instance.prepare('footer', candidate); await instance.restart();
  assert.equal(instance.snapshot().features[0].version, '0.1.1');
  await fs.writeFile(path.join(directory, 'kit.json'), '{invalid', 'utf8');
  await assert.rejects(readKitArtifact(directory), SyntaxError);
});

test('a Kit minimum Core version is validated before loading the artifact', async t => {
  const f = await fixture(t), directory = await f.artifact('requires-core', '0.1.0'), filename = path.join(directory, 'kit.json');
  const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
  await fs.writeFile(filename, JSON.stringify({ ...manifest, minimumCoreVersion: '0.3.19' }), 'utf8');
  assert.equal((await readKitArtifact(directory)).manifest.minimumCoreVersion, '0.3.19');
  await fs.writeFile(filename, JSON.stringify({ ...manifest, minimumCoreVersion: '99.0.0' }), 'utf8');
  await assert.rejects(readKitArtifact(directory), /requires Core 99\.0\.0 or later/);
  await fs.writeFile(filename, JSON.stringify({ ...manifest, minimumCoreVersion: '^0.3.19' }), 'utf8');
  await assert.rejects(readKitArtifact(directory), /Invalid minimum Core version/);
});

test('a backend update is checked and copied before its service switches versions', async t => {
  const f = await fixture(t);
  const make = async (version, source) => {
    const directory = await f.artifact('background', version), file = path.join(directory, 'kit.json');
    const manifest = { ...JSON.parse(await fs.readFile(file, 'utf8')), backendEntry: 'backend.mjs', assets: ['assets/guide.md'], minimumCoreVersion: '0.3.21', services: ['background'] };
    await fs.writeFile(file, JSON.stringify(manifest), 'utf8'); await fs.writeFile(path.join(directory, 'index.mjs'), featureModule({ manifest, create: () => ({ close() {} }) }), 'utf8');
    await fs.writeFile(path.join(directory, 'backend.mjs'), source, 'utf8'); await fs.mkdir(path.join(directory, 'assets')); await fs.writeFile(path.join(directory, 'assets', 'guide.md'), version, 'utf8'); return directory;
  };
  const initial = await make('0.1.0', 'export const value = 1;'), candidate = await make('0.2.0', 'export const value = 2;');
  const configs = [], instance = await featureRuntimePlugin({ artifacts: [initial], services: { background: { module: 'unused' } } }, { serviceFactories: { background: async () => ({
    snapshot: () => ({}), configure(ids, catalog) { if (ids.length) configs.push(catalog.find(value => value.manifest.id === 'background')); }, receive: () => false, removeTarget() {}, close() {},
  }) } }).start(f.context); t.after(() => instance.close()); await instance.connect();
  assert.equal(configs.at(-1).manifest.version, '0.1.0'); const pid = instance.snapshot().hostPid;
  await fs.writeFile(path.join(candidate, 'backend.mjs'), 'export const = ;', 'utf8');
  await assert.rejects(instance.prepare('background', candidate), error => /SyntaxError/.test(error.stderr)); assert.equal(instance.snapshot().hostPid, pid);
  await fs.writeFile(path.join(candidate, 'backend.mjs'), 'export const value = 2;', 'utf8'); await instance.prepare('background', candidate); await instance.restart();
  assert.equal(configs.at(-1).manifest.version, '0.2.0'); assert.equal(await fs.readFile(path.join(configs.at(-1).directory, 'backend.mjs'), 'utf8'), 'export const value = 2;');
  assert.equal(await fs.readFile(path.join(configs.at(-1).directory, 'assets', 'guide.md'), 'utf8'), '0.2.0');
  assert.equal(f.client.closed, false); assert.equal(f.acquisitions, 1);
  await fs.writeFile(path.join(candidate, 'backend.mjs'), 'export const value = 3;', 'utf8'); await assert.rejects(instance.prepare('background', candidate), /different artifact already uses this version/);
});

test('Kit asset paths reject traversal, duplicates and older Core declarations', async t => {
  const f = await fixture(t), directory = await f.artifact('assets', '0.1.0'), file = path.join(directory, 'kit.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const assets of [['../outside'], ['assets/file', 'assets/FILE'], ['index.mjs']]) {
    await fs.writeFile(file, JSON.stringify({ ...manifest, minimumCoreVersion: '0.3.21', assets }), 'utf8'); await assert.rejects(readKitArtifact(directory), /Invalid or duplicate/);
  }
  await fs.writeFile(file, JSON.stringify({ ...manifest, minimumCoreVersion: '0.3.20', assets: ['guide.md'] }), 'utf8');
  await assert.rejects(readKitArtifact(directory), /Kit assets require Core/);
});

test('incompatible service API versions are rejected before any host cleanup', async t => {
  const f = await fixture(t);
  const make = async (version, range, legacy = false) => {
    const directory = await f.artifact('consumer', version), file = path.join(directory, 'kit.json');
    const manifest = { ...JSON.parse(await fs.readFile(file, 'utf8')), services: ['sample'], serviceVersions: { sample: range }, minimumCoreVersion: legacy ? '0.3.22' : '0.3.23' };
    const source = legacy ? 'export default {manifest:' + JSON.stringify(manifest) + ',create:()=>({close(){}})};\n' : featureModule({ manifest, create: () => ({ close() {} }) });
    await fs.writeFile(file, JSON.stringify(manifest), 'utf8'); await fs.writeFile(path.join(directory, 'index.mjs'), source, 'utf8'); return directory;
  };
  const initial = await make('0.1.0', '^1.0.0', true), next = await make('0.2.0', '^2.0.0');
  const factory = Object.assign(async () => ({ snapshot: () => ({}), configure() {}, receive: () => false, removeTarget() {}, close() {} }), { serviceApiVersion: '1.0.0' });
  const instance = await featureRuntimePlugin({ artifacts: [initial], services: { sample: { module: 'unused' } } }, { serviceFactories: { sample: factory } }).start(f.context);
  t.after(() => instance.close()); await instance.connect(); const pid = instance.snapshot().hostPid;
  const source = f.calls.find(call => call.method === 'Page.addScriptToEvaluateOnNewDocument').params.source;
  const page = { __CODEXTOPKITS_FEATURE_ACTION__() {} }, result = await vm.runInNewContext(source, { window: page, document: { readyState: 'complete' } });
  assert.equal(result[0].state, 'running'); await page.__CODEXTOPKITS_FEATURE_HOST__.close();
  await instance.prepare('consumer', next); f.calls.length = 0; await assert.rejects(instance.restart(), /requires sample service API \^2\.0\.0/);
  assert.equal(instance.snapshot().hostPid, pid); assert.equal(f.client.closed, false); assert.equal(f.calls.some(call => call.method === 'Page.removeScriptToEvaluateOnNewDocument'), false);
  factory.serviceApiVersion = '2.0.0'; await instance.restart(); assert.equal(instance.snapshot().features[0].version, '0.2.0');
  const nextSource = f.calls.filter(call => call.method === 'Page.addScriptToEvaluateOnNewDocument').at(-1).params.source;
  const nextPage = { __CODEXTOPKITS_FEATURE_ACTION__() {} }, nextResult = await vm.runInNewContext(nextSource, { window: nextPage, document: { readyState: 'complete' } });
  assert.equal(nextResult[0].state, 'running'); await nextPage.__CODEXTOPKITS_FEATURE_HOST__.close();
});

test('service version declarations require a declared service and a compatible Core', async t => {
  const f = await fixture(t), directory = await f.artifact('consumer', '0.1.0'), file = path.join(directory, 'kit.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...manifest, services: ['sample'], serviceVersions: { other: '^1.0.0' }, minimumCoreVersion: '0.3.22' }), 'utf8');
  await assert.rejects(readKitArtifact(directory), /Invalid Kit service versions/);
  await fs.writeFile(file, JSON.stringify({ ...manifest, services: ['sample'], serviceVersions: { sample: '^1.0.0' }, minimumCoreVersion: '0.3.21' }), 'utf8');
  await assert.rejects(readKitArtifact(directory), /require Core 0.3.22/);
});

test('a real feature-host process restarts without closing its stable CDP lease or the application', async t => {
  const f = await fixture(t), footer = await f.artifact('footer', '0.1.0'), usage = await f.artifact('weekly-usage', '0.1.0', { footer: '0.1.0' });
  const instance = await featureRuntimePlugin({ artifacts: [footer, usage] }).start(f.context);
  t.after(() => instance.close());
  await instance.connect();
  const first = instance.snapshot(); assert.notEqual(first.hostPid, process.pid); assert.equal(first.stablePid, process.pid);
  await instance.restart(); const second = instance.snapshot();
  assert.notEqual(second.hostPid, first.hostPid); assert.equal(second.stablePid, first.stablePid); assert.equal(f.acquisitions, 1); assert.equal(f.client.closed, false);
  assert.ok(!f.calls.some(value => ['Page.reload', 'Browser.close', 'Target.closeTarget'].includes(value.method)));
  instance.select('footer', false);
  await assert.rejects(instance.restart(), /Missing feature dependency/);
  assert.equal(instance.snapshot().hostPid, second.hostPid);
});

test('early services survive CDP reconnection and close without disabling persistent integrations', async t => {
  const f = await fixture(t), directory = await f.artifact('persistent', '0.1.0');
  const manifestFile = path.join(directory, 'kit.json');
  const manifest = { ...JSON.parse(await fs.readFile(manifestFile, 'utf8')), services: ['integration'] };
  await fs.writeFile(manifestFile, JSON.stringify(manifest), 'utf8');
  await fs.writeFile(path.join(directory, 'index.mjs'), featureModule({ manifest, create: () => ({ close() {} }) }), 'utf8');
  const calls = []; let creations = 0;
  const factory = async () => { creations++; return {
    snapshot: () => ({}), receive: () => false, removeTarget() {},
    configure(ids) { calls.push({ type: 'configure', ids: [...ids] }); },
    close() { calls.push({ type: 'close' }); },
  }; };
  const instance = await featureRuntimePlugin({ artifacts: [directory], services: { integration: { module: 'unused', startBeforeCdp: true } } }, { serviceFactories: { integration: factory } }).start(f.context);
  let closed = false; t.after(async () => { if (!closed) await instance.close(); }); await instance.connect();
  const beforeReconnect = calls.length; f.client.closed = true; await f.reconnect();
  assert.equal(creations, 1, 'CDP reconnect retains the early service instance');
  assert.equal(calls.slice(beforeReconnect).some(value => value.type === 'close'), false, 'CDP reconnect does not release the active backend');
  instance.select('persistent', false); await instance.restart();
  assert.ok(calls.some(value => value.type === 'configure' && value.ids.length === 0), 'explicit deselection disables the integration');
  instance.select('persistent', true); await instance.restart();
  const beforeClose = calls.length; await instance.close(); closed = true;
  assert.deepEqual(calls.slice(beforeClose), [{ type: 'close' }], 'host shutdown only closes runtime resources');
});

test('a blocked window prevents restarting every window before any cleanup', async t => {
  const f = await fixture(t), artifact = await f.artifact('fixture', '0.1.0'); let blocked = true;
  f.client.targets = () => ['one', 'two'].map(targetId => ({ targetId, type: 'page', url: 'app://index.html' }));
  f.client.send = async (method, params, sessionId) => {
    f.calls.push({ method, params, sessionId });
    if (method === 'Target.attachToTarget') return { sessionId: 'session-' + params.targetId };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-' + f.calls.length };
    if (method === 'Runtime.evaluate' && blocked && sessionId === 'session-two' && params.expression.includes('host.checkRestart()')) return { exceptionDetails: { exception: { description: 'Voice is active.' } } };
    if (method === 'Runtime.evaluate') return { result: { value: true } };
    return {};
  };
  const instance = await featureRuntimePlugin({ artifacts: [artifact] }).start(f.context);
  t.after(() => instance.close()); await instance.connect();
  const pid = instance.snapshot().hostPid; f.calls.length = 0;
  await assert.rejects(instance.restart(), /Voice is active/);
  assert.equal(instance.snapshot().hostPid, pid); assert.equal(f.client.closed, false);
  assert.equal(f.calls.some(call => call.method === 'Page.removeScriptToEvaluateOnNewDocument' || call.method === 'Runtime.evaluate' && call.params.expression.includes('host.close()')), false);
  assert.equal(f.calls.filter(call => call.method === 'Runtime.evaluate' && call.params.expression.includes('host.checkRestart()')).length, 2);
  blocked = false; await instance.restart(); assert.notEqual(instance.snapshot().hostPid, pid);
});

test('preparing one feature changes only that feature after restart and persists its selection', async t => {
  const f = await fixture(t), footer = await f.artifact('footer', '0.1.0'), usage = await f.artifact('weekly-usage', '0.1.0', { footer: '0.1.0' });
  const options = { artifacts: [footer, usage] }, instance = await featureRuntimePlugin(options).start(f.context);
  await instance.connect();
  const updated = await f.artifact('weekly-usage', '0.2.0', { footer: '0.1.0' });
  const oldPid = instance.snapshot().hostPid; await instance.prepare('weekly-usage', updated);
  assert.equal(instance.snapshot().hostPid, oldPid); assert.equal(instance.snapshot().features[1].version, '0.1.0');
  assert.equal(instance.snapshot().features[1].prepared.version, '0.2.0');
  await instance.restart(); assert.deepEqual(instance.snapshot().features.map(value => value.version), ['0.1.0', '0.2.0']);
  await instance.close(); f.client.closed = false;
  const resumed = await featureRuntimePlugin(options).start(f.context); t.after(() => resumed.close());
  await resumed.connect();
  assert.deepEqual(resumed.snapshot().features.map(value => value.version), ['0.1.0', '0.2.0']);
});

test('new Kits can be installed independently and survive a normal toolkit start', async t => {
  const f = await fixture(t), footer = await f.artifact('footer', '0.1.0'), usage = await f.artifact('weekly-usage', '0.1.0', { footer: '0.1.0' });
  const options = { artifacts: [] }, instance = await featureRuntimePlugin(options).start(f.context);
  await instance.connect(); const original = instance.snapshot(), stablePid = original.stablePid;
  await instance.management.request({ method: 'POST', url: new URL('http://localhost/api/prepare-install'), body: { directory: usage } });
  assert.deepEqual(instance.snapshot().features.map(value => [value.id, value.installed, value.desired]), [['weekly-usage', false, true]]);
  instance.select('weekly-usage', false); assert.equal(instance.snapshot().features[0].desired, false);
  instance.select('weekly-usage', true); assert.equal(instance.snapshot().features[0].desired, true);
  await instance.prepareInstall(usage);
  assert.equal(instance.snapshot().features.filter(value => value.id === 'weekly-usage').length, 1);
  const beforeRetry = await fs.readFile(path.join(usage, 'index.mjs'));
  await fs.appendFile(path.join(usage, 'index.mjs'), '\n// conflicting artifact\n', 'utf8');
  await assert.rejects(instance.prepareInstall(usage), /different artifact already uses this version/);
  await fs.writeFile(path.join(usage, 'index.mjs'), beforeRetry);
  f.calls.length = 0; await assert.rejects(instance.restart(), /Missing feature dependency/);
  assert.equal(instance.snapshot().hostPid, original.hostPid);
  assert.equal(f.calls.some(value => value.method === 'Page.removeScriptToEvaluateOnNewDocument'), false);
  await instance.prepareInstall(footer); await instance.restart();
  assert.deepEqual(instance.snapshot().features.map(value => [value.id, value.installed, value.enabled]), [['weekly-usage', true, true], ['footer', true, true]]);
  assert.equal(instance.snapshot().stablePid, stablePid); assert.equal(f.acquisitions, 1); assert.equal(f.client.closed, false);
  assert.ok(!f.calls.some(value => ['Page.reload', 'Browser.close', 'Target.closeTarget'].includes(value.method)));
  await instance.close(); f.client.closed = false;
  const resumed = await featureRuntimePlugin(options).start(f.context); t.after(() => resumed.close()); await resumed.connect();
  assert.deepEqual(resumed.snapshot().features.map(value => [value.id, value.version, value.enabled]), [['weekly-usage', '0.1.0', true], ['footer', '0.1.0', true]]);
});

test('removing a configured Kit does not turn it into a manager-installed Kit', async t => {
  const f = await fixture(t), footer = await f.artifact('footer', '0.1.0'), other = await f.artifact('other', '0.1.0');
  const instance = await featureRuntimePlugin({ artifacts: [footer] }).start(f.context);
  await instance.prepareInstall(other); await instance.restart(); await instance.close(); f.client.closed = false;
  const resumed = await featureRuntimePlugin({ artifacts: [] }).start(f.context); t.after(() => resumed.close());
  assert.deepEqual(resumed.snapshot().features.map(value => value.id), ['other']);
});

test('updating one Kit keeps a compatible dependent at its own version', async t => {
  const f = await fixture(t), footer = await f.artifact('footer', '0.1.1');
  const usage = await f.artifact('weekly-usage', '0.1.2', { footer: '^0.1.1' });
  const instance = await featureRuntimePlugin({ artifacts: [footer, usage] }).start(f.context);
  t.after(() => instance.close()); await instance.connect();
  const next = await f.artifact('footer', '0.1.2');
  await instance.prepare('footer', next); await instance.restart();
  assert.deepEqual(instance.snapshot().features.map(value => [value.id, value.version]), [['footer', '0.1.2'], ['weekly-usage', '0.1.2']]);
  assert.equal(f.acquisitions, 1); assert.equal(f.client.closed, false);
});

test('legacy and Kit manifest names cannot overwrite a different artifact at the same version', async t => {
  const f = await fixture(t), initial = await f.artifact('footer', '0.1.0'), legacy = await f.artifact('footer', '0.1.1');
  await fs.rename(path.join(legacy, 'kit.json'), path.join(legacy, 'plugin.json'));
  const instance = await featureRuntimePlugin({ artifacts: [initial] }).start(f.context); t.after(() => instance.close());
  await instance.prepare('footer', legacy);
  const other = path.join(f.root, 'other'); await fs.mkdir(other);
  const manifest = JSON.parse(await fs.readFile(path.join(legacy, 'plugin.json'), 'utf8')); manifest.description = 'different artifact';
  await fs.writeFile(path.join(other, 'kit.json'), JSON.stringify(manifest), 'utf8');
  await fs.copyFile(path.join(legacy, 'index.mjs'), path.join(other, 'index.mjs'));
  await assert.rejects(instance.prepare('footer', other), /different artifact/);
  const stored = path.join(f.context.stateDirectory, 'artifacts', 'footer', '0.1.1');
  await assert.rejects(fs.access(path.join(stored, 'kit.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(path.join(stored, 'plugin.json'), 'utf8')).description, undefined);
});

test('a prepared artifact cannot replace the currently installed bytes at the same version', async t => {
  const f = await fixture(t), initial = await f.artifact('footer', '0.1.0'), candidate = path.join(f.root, 'candidate'); await fs.cp(initial, candidate, { recursive: true });
  await fs.appendFile(path.join(candidate, 'index.mjs'), '\n// Different bytes.\n', 'utf8');
  const instance = await featureRuntimePlugin({ artifacts: [initial] }).start(f.context); t.after(() => instance.close()); await instance.connect();
  const pid = instance.snapshot().hostPid; await assert.rejects(instance.prepare('footer', candidate), /different artifact already uses this version/);
  assert.equal(instance.snapshot().hostPid, pid); assert.equal(f.client.closed, false);
});

test('a selected GitHub Kit update is verified and prepared without restarting the stable host', async t => {
  const f = await fixture(t), initial = await f.artifact('footer', '0.1.0'), other = await f.artifact('other', '0.1.0'), candidate = await f.artifact('footer', '0.2.0');
  const bundle = await createKitBundle(candidate, (await readKitArtifact(candidate)).manifest), digest = createHash('sha256').update(bundle).digest('hex');
  const calls = []; let corrupt = true;
  const githubRequest = async (url, headers) => {
    calls.push({ url, headers });
    const json = value => ({ status: 200, headers: {}, bytes: Buffer.from(JSON.stringify(value), 'utf8') });
    if (url.endsWith('/releases/tags/kits')) return json({ id: 7 });
    if (url.includes('/releases/7/assets?')) return json([{ id: 42, name: 'footer-v0.2.0.kit.gz', state: 'uploaded', size: bundle.length, digest: 'sha256:' + digest }]);
    assert.ok(url.endsWith('/releases/assets/42'));
    return { status: 200, headers: {}, bytes: corrupt ? Buffer.from('corrupt') : bundle };
  };
  const instance = await featureRuntimePlugin({ artifacts: [initial, other], githubUpdates: { repository: 'owner/repo' } }, { githubRequest }).start(f.context);
  t.after(() => instance.close()); await instance.connect(); const pid = instance.snapshot().hostPid;
  assert.equal(calls.length, 0);
  const checked = await instance.management.request({ method: 'POST', url: new URL('http://localhost/api/check-updates'), body: { token: 'fixture-secret' } });
  assert.equal(checked.body.features[0].available.version, '0.2.0'); assert.ok(!JSON.stringify(checked.body).includes('fixture-secret'));
  await assert.rejects(instance.prepareUpdate('footer'), /SHA256/);
  assert.equal(instance.snapshot().hostPid, pid); assert.equal(instance.snapshot().features[0].prepared, null);
  corrupt = false;
  const prepared = await instance.prepareUpdate('footer');
  assert.equal(prepared.features[0].version, '0.1.0'); assert.equal(prepared.features[0].prepared.version, '0.2.0');
  assert.equal(prepared.hostPid, pid); assert.equal(f.client.closed, false);
  await instance.restart(); assert.equal(instance.snapshot().features[0].version, '0.2.0');
  assert.equal(instance.snapshot().features[1].version, '0.1.0');
  assert.equal(instance.snapshot().features[0].available, null); assert.equal(f.client.closed, false);
  assert.ok(calls.every(call => call.headers.authorization === 'Bearer fixture-secret'));
  assert.ok(!JSON.stringify(f.logs).includes('fixture-secret'));
});

test('the GitHub catalog downloads and installs only the selected new Kit', async t => {
  const f = await fixture(t), initial = await f.artifact('footer', '0.1.0'), candidate = await f.artifact('extra', '0.1.0');
  const bundle = await createKitBundle(candidate, (await readKitArtifact(candidate)).manifest), digest = createHash('sha256').update(bundle).digest('hex');
  const calls = []; let corrupt = true;
  const githubRequest = async (url, headers) => {
    calls.push({ url, headers }); const json = value => ({ status: 200, headers: {}, bytes: Buffer.from(JSON.stringify(value), 'utf8') });
    if (url.endsWith('/releases/tags/kits')) return json({ id: 7 });
    if (url.includes('/releases/7/assets?')) return json([{ id: 42, name: 'extra-v0.1.0.kit.gz', state: 'uploaded', size: bundle.length, digest: 'sha256:' + digest }]);
    assert.ok(url.endsWith('/releases/assets/42')); return { status: 200, headers: {}, bytes: corrupt ? Buffer.from('corrupt') : bundle };
  };
  const options = { artifacts: [initial], githubUpdates: { repository: 'owner/repo' } };
  const instance = await featureRuntimePlugin(options, { githubRequest }).start(f.context); t.after(() => instance.close()); await instance.connect();
  const pid = instance.snapshot().hostPid, result = await instance.checkUpdates('fixture-secret');
  assert.deepEqual(result.availableKits, [{ id: 'extra', version: '0.1.0' }]);
  assert.equal(calls.filter(call => call.url.includes('/releases/assets/')).length, 0);
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  await assert.rejects(instance.prepareAvailableInstall('extra'), /SHA256/);
  assert.equal(instance.snapshot().hostPid, pid); assert.deepEqual(instance.snapshot().availableKits, [{ id: 'extra', version: '0.1.0' }]);
  corrupt = false;
  const prepared = await instance.management.request({ method: 'POST', url: new URL('http://localhost/api/prepare-available-install'), body: { id: 'extra' } });
  assert.equal(prepared.body.features.find(value => value.id === 'extra').installed, false); assert.deepEqual(prepared.body.availableKits, []);
  assert.equal(prepared.body.hostPid, pid); assert.equal(f.client.closed, false);
  await instance.restart(); assert.equal(instance.snapshot().features.find(value => value.id === 'extra').enabled, true);
  assert.equal(f.client.closed, false); assert.ok(!JSON.stringify(f.logs).includes('fixture-secret'));
});

test('closing the Kit runtime cancels an in-flight update check', async t => {
  const f = await fixture(t), initial = await f.artifact('footer', '0.1.0');
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const githubRequest = (_url, _headers, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started();
  });
  const instance = await featureRuntimePlugin({ artifacts: [initial], githubUpdates: { repository: 'owner/repo' } }, { githubRequest }).start(f.context);
  const result = assert.rejects(instance.checkUpdates('fixture-secret'), /Feature runtime stopped/);
  await ready; await instance.close(); await result;
  assert.ok(!JSON.stringify(f.logs).includes('fixture-secret'));
});

test('toolkit readiness does not wait for Codex to open, and closing cancels only its own pending acquire', async t => {
  const f = await fixture(t), directory = await f.artifact('footer', '0.1.0');
  f.context.cdp.acquire = ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const instance = await featureRuntimePlugin({ artifacts: [directory] }).start(f.context);
  assert.equal(instance.snapshot().phase, 'waiting-for-app');
  await instance.close(); assert.equal(f.client.closed, false);
});

test('a loader failure retains the original error while cleaning its own startup resources', async t => {
  const f = await fixture(t), directory = await f.artifact('broken', '0.1.0');
  await fs.appendFile(path.join(directory, 'index.mjs'), '\nthrow new TypeError("Original feature module failure");\n', 'utf8');
  await assert.rejects(featureRuntimePlugin({ artifacts: [directory] }).start(f.context), error => error.name === 'TypeError' && error.message === 'Original feature module failure');
  assert.equal(f.acquisitions, 0); assert.equal(f.client.closed, false);
});

test('reconnection reattaches the current version without activating a prepared update', async t => {
  const f = await fixture(t), initial = await f.artifact('footer', '0.1.0'), candidate = await f.artifact('footer', '0.2.0');
  const instance = await featureRuntimePlugin({ artifacts: [initial] }).start(f.context); t.after(() => instance.close()); await instance.connect();
  await instance.prepare('footer', candidate); const pid = instance.snapshot().hostPid;
  f.client.closed = true; await f.reconnect();
  assert.equal(instance.snapshot().hostPid, pid); assert.equal(instance.snapshot().features[0].version, '0.1.0'); assert.equal(instance.snapshot().features[0].prepared.version, '0.2.0');
  assert.equal(instance.snapshot().pages.length, 1); assert.equal(f.acquisitions, 2);
});

test('reconnection removes old page state errors and ignores only late closed-connection failures', async t => {
  const f = await fixture(t), directory = await f.artifact('state-consumer', '0.1.0');
  const manifestFile = path.join(directory, 'kit.json');
  const manifest = { ...JSON.parse(await fs.readFile(manifestFile, 'utf8')), services: ['source'] };
  await fs.writeFile(manifestFile, JSON.stringify(manifest), 'utf8');
  await fs.writeFile(path.join(directory, 'index.mjs'), featureModule({ manifest, create: () => ({ close() {} }) }), 'utf8');
  let hostUpdate, notifyState;
  f.context.onHostState = listener => { hostUpdate = listener; listener({ health: { plugins: [] } }); return () => {}; };
  const source = async (_options, { notify }) => {
    notifyState = notify;
    return { configure() {}, close() {}, removeTarget() {}, snapshot: () => ({}), receive: () => false };
  };
  const instance = await featureRuntimePlugin({ artifacts: [directory], services: { source: { module: 'unused' } } }, { serviceFactories: { source } }).start(f.context);
  t.after(() => instance.close()); await instance.connect();
  const send = f.client.send.bind(f.client), pending = [];
  let mode = 'fail';
  f.client.send = async (method, params, sessionId) => {
    const isState = method === 'Runtime.evaluate' && /\?\.set(?:Runtime|Host)State\(/.test(params.expression);
    if (isState && mode === 'fail') throw new TypeError('Original state failure');
    if (isState && mode === 'hold') return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    return send(method, params, sessionId);
  };
  await notifyState(); hostUpdate({ health: { plugins: [] } }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(instance.snapshot().errors.map(value => value.key).sort(), ['host-state:one', 'state:one']);
  assert.ok(instance.snapshot().errors.every(value => value.name === 'TypeError' && value.message === 'Original state failure'));

  mode = 'hold'; const oldDelivery = notifyState(); hostUpdate({ health: { plugins: [] } });
  assert.equal(pending.length, 2);
  mode = 'pass'; f.client.closed = true; await f.reconnect();
  assert.deepEqual(instance.snapshot().errors, [], 'old page errors are cleared when the connection is replaced');
  for (const { reject } of pending) reject(Object.assign(new Error('CDP consumer is closed: features'), { code: 'CDP_CONSUMER_CLOSED' }));
  await oldDelivery; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(instance.snapshot().errors, [], 'late failures from the previous page cannot recreate the errors');

  mode = 'hold'; pending.length = 0; const oldSuccess = notifyState(); hostUpdate({ health: { plugins: [] } });
  mode = 'pass'; f.client.closed = true; await f.reconnect();
  mode = 'fail'; await notifyState(); hostUpdate({ health: { plugins: [] } }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(instance.snapshot().errors.map(value => value.key).sort(), ['host-state:one', 'state:one']);
  assert.ok(instance.snapshot().errors.every(value => value.name === 'TypeError' && value.message === 'Original state failure'));
  for (const { resolve } of pending) resolve({ result: { value: true } });
  await oldSuccess; await new Promise(resolve => setImmediate(resolve));
  assert.equal(instance.snapshot().errors.length, 2, 'late success from the previous page cannot erase current errors');
  mode = 'pass'; await notifyState(); hostUpdate({ health: { plugins: [] } }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(instance.snapshot().errors, [], 'real errors on the current page still clear on successful delivery');

  mode = 'hold'; pending.length = 0; const removedDelivery = notifyState(); hostUpdate({ health: { plugins: [] } });
  await Promise.all([...f.client.handlers].map(handler => handler({ method: 'Target.targetDestroyed', params: { targetId: 'one' } })));
  pending[0].reject(Object.assign(new Error('CDP consumer is closed: features'), { code: 'CDP_CONSUMER_CLOSED' }));
  pending[1].reject(Object.assign(new Error('CDP disconnected.'), { code: 'CDP_DISCONNECTED' }));
  await removedDelivery; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(instance.snapshot().errors, [], 'a removed page cannot report late disconnect failures');

  mode = 'pass'; await Promise.all([...f.client.handlers].map(handler => handler({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'one', type: 'page', url: 'app://index.html' } } })));
  mode = 'hold'; pending.length = 0; const unexpectedDelivery = notifyState(); hostUpdate({ health: { plugins: [] } });
  await Promise.all([...f.client.handlers].map(handler => handler({ method: 'Target.targetDestroyed', params: { targetId: 'one' } })));
  pending[0].reject(new TypeError('Unexpected delayed failure'));
  pending[1].reject(Object.assign(new Error('CDP consumer is closed: features'), { code: 'CDP_CONSUMER_CLOSED' }));
  await unexpectedDelivery; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(instance.snapshot().errors.map(({ key, name, message }) => ({ key, name, message })),
    [{ key: 'state:one', name: 'TypeError', message: 'Unexpected delayed failure' }]);
});
