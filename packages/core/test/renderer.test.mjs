import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAssetReader, loadNativeAppServices } from '../src/renderer.mjs';

test('a failed entry read and prefix resolution can recover without discarding successful asset resolutions', async () => {
  const original = new TypeError('Temporary entry fetch failure'); let calls = 0;
  const assets = createNativeAssetReader({ scripts: [{ src: 'app://-/assets/index-fixture.js' }] }, { fetchModule: async () => {
    if (++calls === 1) throw original;
    return { ok: true, text: async () => 'import "./rpc-fixture.js"; import "./app-initial-fixture.js";' };
  } });
  await assert.rejects(assets.resolve('rpc'), error => error === original);
  assert.equal(await assets.resolve('rpc'), 'app://-/assets/rpc-fixture.js');
  assert.equal(await assets.resolve('app-initial'), 'app://-/assets/app-initial-fixture.js');
  assert.equal(calls, 2); assert.equal(assets.resolve('rpc'), assets.resolve('rpc'));
});

test('a failed runtime import or owner lookup can recover while successful runtime and owner caches remain shared', async () => {
  const original = new TypeError('Temporary runtime import failure'); let imports = 0;
  const require = () => ({ marker: true }); require.m = { healthy: function healthy() { return 'healthy fixture'; } }; require.c = {};
  const assets = createNativeAssetReader({ scripts: [{ type: 'module', src: 'app://-/assets/main.fixture.js' }] }, { importModule: async () => {
    if (++imports === 1) throw original;
    return { __webpack_require__: require };
  } });
  await assert.rejects(assets.find('late', source => source.includes('late fixture')), error => error === original);
  const healthy = await assets.find('healthy', source => source.includes('healthy fixture'));
  await assert.rejects(assets.find('late', source => source.includes('late fixture')), /0 matching modules/);
  require.m.late = function late() { return 'late fixture'; };
  assert.equal((await assets.find('late', source => source.includes('late fixture'))).load().marker, true);
  assert.equal(await assets.find('healthy', source => source.includes('healthy fixture')), healthy);
  assert.equal(imports, 2);
});

test('native assets share bootstrap reads, including the app-main indirection', async () => {
  const document = { scripts: [{ src: 'app://-/assets/index-fixture.js' }] }, calls = [];
  const assets = createNativeAssetReader(document, { fetchModule: async url => {
    calls.push(url); return { ok: true, text: async () => url.includes('index-') ? 'import "./app-main-fixture.js"' : 'import "./app-initial-fixture.js"' };
  } });
  assert.equal(await assets.resolve('app-initial'), 'app://-/assets/app-initial-fixture.js');
  await assets.resolve('app-initial'); assert.equal(calls.length, 2);
});

test('native app services discovery works with Rspack without requiring updater APIs', async () => {
  const services = { projectCatalog: { readLocalProjects() {} } };
  const require = () => ({ appServices: services });
  require.m = { services: function servicesOwner() { return { setAppServices: null, appServices: null }; } }; require.c = {};
  const document = { scripts: [{ type: 'module', src: 'app://-/assets/main.fixture.js' }] };
  const assets = createNativeAssetReader(document, { importModule: async () => ({ __webpack_require__: require }) });
  assert.equal(await loadNativeAppServices(document, { assets }), services);
});

test('native services use the known ESM RPC export and preserve original module errors', async () => {
  const original = new SyntaxError('fixture native module failed');
  const document = { scripts: [{ src: 'app://-/assets/index-fixture.js' }] };
  const assets = createNativeAssetReader(document, { fetchModule: async () => ({ ok: true, text: async () => 'import "./rpc-fixture.js"' }) });
  const services = { threadProjectAssignments: {} };
  assert.equal(await loadNativeAppServices(document, { assets, importModule: async () => ({ appServices: services }) }), services);
  await assert.rejects(loadNativeAppServices(document, { assets, importModule: async () => { throw original; } }), error => error === original);
  assert.doesNotThrow(() => new Function('return (' + createNativeAssetReader.toString() + ')'));
});
