import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const [installation, opensslPath] = process.argv.slice(2);
if (!installation || !path.isAbsolute(installation) || !opensslPath) throw new Error('Pass an absolute artifact installation directory and the OpenSSL executable.');
const root = await fs.realpath(installation);
const require = createRequire(path.join(root, 'package.json'));
const entries = Object.fromEntries(['codex-toolkit-core', 'codex-bandwidth', 'sharp', 'ws'].map(name => [name, require.resolve(name)]));
const core = await import(pathToFileURL(entries['codex-toolkit-core']));
const bandwidth = await import(pathToFileURL(entries['codex-bandwidth']));
const certificateOptions = opensslPath === 'native' ? {} : { opensslPath };
const execute = promisify(execFile);
const runtimeModule = await import(pathToFileURL(require.resolve('codex-toolkit-core/runtime')));

// This test process must not inherit an existing installation's certificate bundle.
delete process.env.CODEX_CA_CERTIFICATE;
delete process.env.SSL_CERT_FILE;

test('the installed manager serves the bandwidth page and live database from one runtime owner', async t => {
  const directory = path.join(root, 'test-state', 'managed-traffic');
  const runtime = await runtimeModule.startRuntime({ stateDirectory: directory, plugins: [bandwidth.bandwidthPlugin(certificateOptions)] });
  t.after(() => runtime.close());
  const status = await runtimeModule.requestRuntime(directory, 'status');
  const base = status.managerUrl + 'plugins/bandwidth/';
  const page = await (await fetch(base)).text();
  assert.match(page, /返回工具管理页/);
  assert.match(page, /fetch\('api\/traffic/);
  const response = await fetch(base + 'api/traffic');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.modelThreads, []);
  assert.equal(data.coverage.find(item => item.id === 'windows-network').status, 'disabled');
  assert.equal(data.coverage.find(item => item.id === 'chromium').status, 'disabled');
  assert.equal((await fetch(base + 'api/traffic-capture', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await runtimeModule.requestRuntime(directory, 'status')).pid, status.pid);
});

test('the installed rules command operates only on an explicit synthetic Codex home', async () => {
  const codexHome = path.join(root, 'test-state', 'synthetic-codex-home');
  const stateDirectory = path.join(root, 'test-state', 'rules');
  const cli = path.join(path.dirname(entries['codex-bandwidth']), 'cli.mjs');
  const installed = await execute(process.execPath, [cli, 'install-rules', codexHome, stateDirectory], { encoding: 'utf8', windowsHide: true });
  const status = JSON.parse(installed.stdout);
  assert.equal(status.installed, true);
  assert.equal(status.trust, 'not-checked');
  const skill = await fs.readFile(status.skillFile, 'utf8');
  assert.ok(skill.includes(root.replaceAll('\\', '/')));
  assert.ok(!skill.includes('{{'));
  const removed = await execute(process.execPath, [cli, 'remove-rules', codexHome, stateDirectory], { encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(removed.stdout).removed, true);
});

test('public imports and dependencies resolve inside the artifact installation, not source repositories', async () => {
  for (const entry of Object.values(entries)) {
    const relative = path.relative(root, await fs.realpath(entry));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  }
  assert.equal(core.CORE_API_VERSION, 1);
  assert.equal(bandwidth.bandwidthPlugin().coreApiVersion, 1);
});

test('the installed image transform refreshes an expired reference instead of returning its old ID', async t => {
  const start = Date.parse('2026-11-07T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const { createImageReferenceTransform } = await import(pathToFileURL(path.join(path.dirname(entries['codex-bandwidth']), 'image-reference-transform.mjs')));
  let uploads = 0;
  const transform = await createImageReferenceTransform({ upload: async () => 'file_' + ++uploads });
  const data = Buffer.from(JSON.stringify({ input: [{ type: 'message', content: [{ type: 'input_image', image_url: 'data:image/webp;base64,c25hcHNob3Q=' }] }] }));
  const context = { path: '/backend-api/codex/responses', transport: 'websocket', headers: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture-account' } };
  assert.equal(JSON.parse(await transform(data, context)).input[0].content[0].file_id, 'file_1');
  t.mock.timers.setTime(start + 7 * 24 * 60 * 60 * 1000);
  assert.equal(JSON.parse(await transform(data, context)).input[0].content[0].file_id, 'file_2');
  assert.equal(uploads, 2);
  await transform(data, context); assert.equal(uploads, 2);
});

test('the installed public image tool preserves a synthetic source and emits lossy original-size WebP', async () => {
  const sharp = (await import(pathToFileURL(entries.sharp))).default;
  const { prepareModelImage } = await import(pathToFileURL(require.resolve('codex-bandwidth/prepare-image')));
  const { inspectFile } = await import(pathToFileURL(require.resolve('codex-bandwidth/image-audit')));
  const project = path.join(root, 'test-state', 'synthetic-project');
  await fs.mkdir(project, { recursive: true });
  const source = path.join(project, '合成样例.png');
  await sharp({ create: { width: 64, height: 32, channels: 3, background: '#4c72a8' } }).png().toFile(source);
  const before = await fs.readFile(source);
  const prepared = await prepareModelImage({ source, project });
  const actual = await inspectFile(prepared.path);
  assert.equal(actual.format, 'webp');
  assert.equal(actual.compression, 'lossy');
  assert.deepEqual([actual.width, actual.height], [64, 32]);
  assert.deepEqual(await fs.readFile(source), before);
});

test('the installed host starts and closes its own HTTPS plugin without modifying Codex routing', async t => {
  const directory = path.join(root, 'test-state', 'host');
  const previousRoute = process.env.CODEX_APP_SERVER_OPENAI_BASE_URL;
  const host = await core.createPluginHost({ stateDirectory: directory, plugins: [bandwidth.bandwidthPlugin(certificateOptions)] });
  t.after(() => host.close());
  assert.equal(host.health().ok, true);
  assert.equal(host.health().plugins.length, 1);
  assert.match(host.health().plugins[0].message, /routing has not been verified/);
  const environment = host.getPlugin('bandwidth').launchEnvironment;
  assert.equal(process.env.CODEX_APP_SERVER_OPENAI_BASE_URL, previousRoute);
  assert.equal(process.env.CODEX_CA_CERTIFICATE, undefined);
  const address = new URL(environment.CODEX_APP_SERVER_OPENAI_BASE_URL);
  assert.equal(address.protocol, 'https:');
  assert.equal(address.hostname, '127.0.0.1');
  const ca = await fs.readFile(environment.CODEX_CA_CERTIFICATE);
  assert.equal((ca.toString('utf8').match(/BEGIN CERTIFICATE/g) ?? []).length, 1);
  const socket = tls.connect({ host: address.hostname, port: Number(address.port), ca });
  t.after(() => socket.destroy());
  await once(socket, 'secureConnect');
  assert.equal(socket.authorized, true);
  const closed = once(socket, 'close');
  socket.destroy();
  await closed;
  await host.close();
  assert.equal(host.health().ok, false);
});

test('an installed plugin with an incompatible API is refused before it creates state or starts', async () => {
  const directory = path.join(root, 'test-state', 'incompatible');
  const plugin = { ...bandwidth.bandwidthPlugin(), coreApiVersion: 999 };
  await assert.rejects(core.createPluginHost({ stateDirectory: directory, plugins: [plugin] }), /Incompatible core API/);
  await assert.rejects(fs.stat(directory), error => error.code === 'ENOENT');
});

test('a missing certificate tool preserves its actual startup error rather than reporting success', async () => {
  await assert.rejects(core.createPluginHost({ stateDirectory: path.join(root, 'test-state', 'missing-tool'),
    plugins: [bandwidth.bandwidthPlugin({ opensslPath: path.join(root, 'missing-openssl.exe') })],
  }), error => error.code === 'ENOENT');
});

test('installed background commands preserve one owner through start, stop, and process death', async t => {
  const coreDirectory = path.join(root, 'node_modules', 'codex-toolkit-core');
  const manifest = JSON.parse(await fs.readFile(path.join(coreDirectory, 'package.json'), 'utf8'));
  const cli = path.join(coreDirectory, manifest.bin['codex-toolkit']);
  const config = path.join(root, 'runtime-test.json');
  await fs.writeFile(config, JSON.stringify({ stateDirectory: './test-state/runtime', plugins: [
    { module: 'codex-bandwidth', options: certificateOptions },
  ] }), 'utf8');
  const run = action => execute(process.execPath, [cli, action, config], { encoding: 'utf8', windowsHide: true });
  t.after(async () => { if (JSON.parse((await run('status')).stdout).phase === 'running') await run('stop'); });
  const ready = JSON.parse((await run('start')).stdout);
  assert.equal(ready.ready, true);
  assert.equal(JSON.parse((await run('status')).stdout).instanceId, ready.instanceId);
  await assert.rejects(run('start'), error => /EADDRINUSE/.test(error.stderr));
  const environment = JSON.parse((await run('environment')).stdout).environment;
  assert.equal(new URL(environment.CODEX_APP_SERVER_OPENAI_BASE_URL).hostname, '127.0.0.1');
  await run('stop');
  assert.equal(JSON.parse((await run('status')).stdout).phase, 'stopped');

  const child = spawn(process.execPath, [cli, 'serve', config], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [restarted] = await once(child, 'message');
  assert.equal(restarted.ready, true);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const fresh = JSON.parse((await run('start')).stdout);
  assert.notEqual(fresh.instanceId, restarted.instanceId);
  await run('stop');
});
