import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readCatalog, selectKits, createConfig, prepareSourceInstall } from './prepare-source-install.mjs';

const paths = { destination: path.resolve('install-example'), node: process.execPath, powershell: process.execPath, codexHome: path.resolve('codex-home') };
const plugin = (config, name) => config.plugins.find(item => item.module === name);

test('selects only requested Kits and their dependencies, respecting opt-in', async () => {
  const catalog = await readCatalog();
  const selected = selectKits(catalog, ['window-tabs']);
  assert.deepEqual(new Set(selected.map(item => item.manifest.id)), new Set(['window-tabs', 'footer']));
  assert.equal(selected.some(item => item.manifest.id === 'agent-model-protection'), false);
  assert.throws(() => selectKits(catalog, ['missing-kit']), /Unknown Kit/);
  assert.throws(() => selectKits(catalog, []), /at least one Kit/);
  const wrong = new Map(catalog);
  wrong.set('footer', { ...catalog.get('footer'), manifest: { ...catalog.get('footer').manifest, version: '9.0.0' } });
  assert.throws(() => selectKits(wrong, ['window-tabs']), /Incompatible feature dependency/);
});

test('configures existing modules, handoffs, services and explicit protection', async () => {
  const catalog = await readCatalog();
  const names = ['ui-font-size', 'agent-model-protection', 'context-recovery-integration', 'image-policy-rules', 'image-reference-dedup', 'traffic-observer', 'awake-bridge'];
  const kits = selectKits(catalog, names);
  const config = createConfig(kits, paths);
  const host = plugin(config, 'codex-toolkit-core/kit-runtime');
  assert.equal(config.plugins.at(-1), host);
  assert.deepEqual(host.options.githubUpdates, { repository: 'author2058/CodexTopKits' });
  assert.doesNotMatch(JSON.stringify(config), /CodexTopKits-dev/);
  assert.deepEqual(host.options.enabled, names);
  assert.deepEqual(plugin(config, 'codex-toolkit-themes').options.externalKits, ['ui-font-size', 'project-thread-colors', 'profile-panel-shadow']);
  assert.equal(host.options.services['theme-settings'].options.legacyPlugin, 'themes');
  assert.deepEqual(plugin(config, 'codex-toolkit-session').options.externalKits, ['agent-model-protection']);
  assert.equal(plugin(config, 'codex-toolkit-session').options.restoreAgentComposer, false);
  assert.equal(host.options.services['session-runtime'].startBeforeCdp, true);
  assert.equal(host.options.services['context-recovery'].startBeforeCdp, true);
  assert.equal(host.options.services['context-recovery'].options.codexHome, paths.codexHome);
  assert.equal(host.options.services['context-recovery'].options.nodeExecutable, paths.node);
  assert.equal(host.options.services['image-policy'].options.codexHome, paths.codexHome);
  assert.equal(host.options.services['image-policy'].startBeforeCdp, true);
  assert.equal(host.options.services['image-reference'].startBeforeCdp, true);
  assert.equal(host.options.services['traffic-observer'].startBeforeCdp, true);
  assert.equal(plugin(config, 'codex-bandwidth').options.cdpPort, 'auto');
  assert.equal(host.options.services.awake.options.powershellPath, paths.powershell);
  assert.equal('awakeScript' in host.options.services.awake.options, false);
  assert.equal('opensslPath' in plugin(config, 'codex-bandwidth').options, false);
  assert.throws(() => createConfig(kits, { ...paths, codexHome: undefined }), /require --codex-home/);
});

test('accepts a trusted update repository and rejects invalid names before changing the destination', async t => {
  const catalog = await readCatalog();
  const kits = selectKits(catalog, ['footer']);
  const custom = createConfig(kits, { ...paths, updateRepository: 'trusted/private-catalog' });
  assert.deepEqual(plugin(custom, 'codex-toolkit-core/kit-runtime').options.githubUpdates, { repository: 'trusted/private-catalog' });
  assert.throws(() => createConfig(kits, { ...paths, updateRepository: 'https://example.com/repo' }), /owner\/repository/);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codextopkits-install-repository-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const destination = path.join(directory, 'new');
  const result = spawnSync(process.execPath, [path.resolve('tools/prepare-source-install.mjs'), '--destination', destination, '--node', process.execPath, '--powershell', process.execPath, '--kit', 'footer', '--update-repository', 'invalid/repo/extra'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /owner\/repository/);
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
});

test('single policy or theme selection leaves unrelated Kits disabled', async () => {
  const catalog = await readCatalog();
  const policy = createConfig(selectKits(catalog, ['image-policy-rules']), paths);
  const policyHost = plugin(policy, 'codex-toolkit-core/kit-runtime');
  assert.deepEqual(policyHost.options.enabled, ['image-policy-rules']);
  assert.deepEqual(Object.keys(policyHost.options.services), ['image-policy']);
  assert.equal('cdpPort' in plugin(policy, 'codex-bandwidth').options, false);
  assert.deepEqual(plugin(policy, 'codex-bandwidth').options.externalKits, ['image-policy-rules', 'image-reference-dedup', 'traffic-observer']);
  const theme = createConfig(selectKits(catalog, ['ui-font-size']), paths);
  const themeHost = plugin(theme, 'codex-toolkit-core/kit-runtime');
  assert.deepEqual(themeHost.options.enabled, ['ui-font-size']);
  assert.deepEqual(Object.keys(themeHost.options.services), ['theme-settings']);
  assert.deepEqual(plugin(theme, 'codex-toolkit-themes').options.externalKits, ['ui-font-size', 'project-thread-colors', 'profile-panel-shadow']);
});

test('sets up only needed services and rejects unsupported services', async () => {
  const catalog = await readCatalog();
  const host = plugin(createConfig(selectKits(catalog, ['app-restart']), paths), 'codex-toolkit-core/kit-runtime');
  assert.deepEqual(Object.keys(host.options.services), ['app-restart']);
  assert.equal(host.options.services['app-restart'].options.configPath, path.join(paths.destination, 'toolkit.json'));
  const item = catalog.get('footer');
  assert.throws(() => createConfig([{ ...item, manifest: { ...item.manifest, services: ['unknown'] } }], paths), /No source-install configuration/);
  assert.throws(() => createConfig([item], { ...paths, destination: 'relative' }), /absolute path/);
  const guard = plugin(createConfig(selectKits(catalog, ['update-restart-protection']), paths), 'codex-toolkit-core/kit-runtime');
  assert.equal(guard.options.services['restart-protection'].options.powershellPath, paths.powershell);
});

test('preserves a failing subprocess error', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codextopkits-install-error-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const failure = new Error('original npm failure');
  const options = { destination: path.join(directory, 'new'), node: process.execPath, powershell: process.execPath, npm: process.execPath, kits: ['footer'] };
  await assert.rejects(prepareSourceInstall(options, { run() { throw failure; } }), error => error === failure);
});

test('prepares isolated paths using injected process calls and preserves a nonempty target', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codextopkits-install-test-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const destination = path.join(directory, 'new');
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[1] === 'pack') return JSON.stringify([{ filename: 'package-' + calls.length + '.tgz' }]);
    return '';
  };
  const options = { destination, node: process.execPath, powershell: process.execPath, npm: process.execPath, kits: ['footer'] };
  const result = await prepareSourceInstall(options, { run });
  const config = JSON.parse(await fs.readFile(result.configPath, 'utf8'));
  assert.deepEqual(plugin(config, 'codex-toolkit-core/kit-runtime').options.enabled, ['footer']);
  assert.deepEqual(plugin(config, 'codex-toolkit-core/kit-runtime').options.githubUpdates, { repository: 'author2058/CodexTopKits' });
  assert.equal(JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8')).private, true);
  assert.ok(calls.some(call => call.args.includes('--offline') && call.args.includes('--ignore-scripts')));
  assert.equal(calls.at(-1).args[1], 'prepare');
  const before = calls.length;
  await assert.rejects(prepareSourceInstall(options, { run }), /destination must be empty/);
  assert.equal(calls.length, before);
  assert.deepEqual(JSON.parse(await fs.readFile(result.configPath, 'utf8')), config);
  await assert.rejects(prepareSourceInstall({ ...options, updateRepository: 'invalid/repo/extra' }, { run }), /owner\/repository/);
  assert.equal(calls.length, before);
  assert.deepEqual(JSON.parse(await fs.readFile(result.configPath, 'utf8')), config);
  const custom = await prepareSourceInstall({ ...options, destination: path.join(directory, 'custom'), updateRepository: 'trusted/private-catalog' }, { run });
  const customConfig = JSON.parse(await fs.readFile(custom.configPath, 'utf8'));
  assert.deepEqual(plugin(customConfig, 'codex-toolkit-core/kit-runtime').options.githubUpdates, { repository: 'trusted/private-catalog' });
});
