import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readDeployment } from '../src/deployment.mjs';
import { applyDeployment } from '../src/deployment.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { requestRuntime } from '../src/runtime.mjs';
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-deploy-')), configPath = path.join(root, 'toolkit.json');
  await fs.writeFile(configPath, '{}', 'utf8');
  const archive = path.join(root, 'fixture.tgz'); await fs.writeFile(archive, 'fixture', 'utf8');
  const revision = 'a'.repeat(40), manifest = { version: 1, sourceRevision: revision, review: { head: revision, outcome: 'PASS' }, artifacts: [{ name: 'fixture-kit', version: '1.0.0', path: archive, sha256: createHash('sha256').update('fixture').digest('hex') }], kitUpdates: [] };
  const save = () => fs.writeFile(path.join(root, 'pending-deployment.json'), JSON.stringify(manifest), 'utf8');
  return { root, configPath, archive, manifest, save };
}
test('no prepared update is an ordinary launch', async () => {
  const f = await fixture(); assert.equal(await readDeployment(f.configPath), null);
});
test('deployment requires an exact reviewed head and matching immutable archive bytes', async () => {
  const f = await fixture(); await f.save();
  assert.equal((await readDeployment(f.configPath)).manifest.sourceRevision, f.manifest.sourceRevision);
  f.manifest.review.head = 'b'.repeat(40); await f.save(); await assert.rejects(readDeployment(f.configPath), /approved source/);
  f.manifest.review.head = f.manifest.sourceRevision; await f.save(); await fs.writeFile(f.archive, 'changed', 'utf8');
  await assert.rejects(readDeployment(f.configPath), /checksum/);
});
test('corrupt deployment does not become absence', async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.root, 'pending-deployment.json'), '{', 'utf8');
  await assert.rejects(readDeployment(f.configPath), SyntaxError);
});
test('deployment preflight rejects duplicate configured Kit IDs before running any process', async () => {
  const f = await fixture(), artifacts = [];
  for (const version of ['0.1.0', '0.1.1']) {
    const directory = path.join(f.root, version); await fs.mkdir(directory); artifacts.push(directory);
    await fs.writeFile(path.join(directory, 'kit.json'), JSON.stringify({ id: 'app-restart', version, coreApiVersion: 1, entry: 'index.mjs', dependencies: {} }), 'utf8');
    await fs.writeFile(path.join(directory, 'index.mjs'), 'export default {};', 'utf8');
  }
  const config = { plugins: [{ module: 'codex-toolkit-core/kit-runtime', options: { artifacts } }] };
  await fs.writeFile(f.configPath, JSON.stringify(config), 'utf8'); await f.save();
  await assert.rejects(readDeployment(f.configPath), /Duplicate installed feature ID: app-restart/);
  await assert.rejects(applyDeployment(f.configPath, { run() { assert.fail('must reject before running a process'); } }), /Duplicate installed feature ID: app-restart/);
  const candidate = path.join(f.root, 'next.json'), bytes = JSON.stringify({ ...config, plugins: [{ module: 'codex-toolkit-core/kit-runtime', options: { artifacts: [artifacts[1]] } }] });
  await fs.writeFile(candidate, bytes, 'utf8');
  const hash = value => createHash('sha256').update(value).digest('hex');
  f.manifest.config = { path: candidate, sha256: hash(bytes), originalSha256: hash(await fs.readFile(f.configPath)) }; await f.save();
  assert.equal((await readDeployment(f.configPath)).manifest.config.path, candidate, 'validate the replacement configuration instead of the superseded one');
});
test('deployment preflight uses the Core version that the approved update will install', async () => {
  const f = await fixture(), directory = path.join(f.root, 'new-kit'); await fs.mkdir(directory);
  const kit = { id: 'example', version: '0.1.0', coreApiVersion: 1, entry: 'index.mjs', dependencies: {}, minimumCoreVersion: '9.0.0' };
  await fs.writeFile(path.join(directory, 'kit.json'), JSON.stringify(kit), 'utf8');
  await fs.writeFile(path.join(directory, 'index.mjs'), 'export default {};', 'utf8');
  await fs.writeFile(f.configPath, JSON.stringify({ plugins: [{ module: 'codex-toolkit-core/kit-runtime', options: { artifacts: [directory] } }] }), 'utf8');
  f.manifest.artifacts[0].name = 'codex-toolkit-core'; f.manifest.artifacts[0].version = '9.0.0'; await f.save();
  assert.equal((await readDeployment(f.configPath)).manifest.artifacts[0].version, '9.0.0');
  f.manifest.artifacts[0].version = '8.0.0'; await f.save();
  await assert.rejects(readDeployment(f.configPath), /requires Core 9\.0\.0/);
  f.manifest.artifacts = []; await f.save();
  await assert.rejects(readDeployment(f.configPath), /requires Core 9\.0\.0/);
});
test('Kit-only deployment keeps Codex, the stable runtime and transport open', async t => {
  for (const scenario of ['running', 'stopped', 'prepared-only', 'conflict', 'not-installed']) {
  const f = await fixture(), kitDir = path.join(f.root, 'example-1.0.0'); await fs.mkdir(kitDir);
  const kit = { id: 'example', version: '1.0.0', entry: 'index.mjs' };
  await fs.writeFile(path.join(kitDir, 'kit.json'), JSON.stringify(kit), 'utf8'); await fs.writeFile(path.join(kitDir, 'index.mjs'), 'export default {};', 'utf8');
  const files = {};
  for (const name of ['kit.json', 'index.mjs']) files[name] = createHash('sha256').update(await fs.readFile(path.join(kitDir, name))).digest('hex');
  f.manifest.artifacts = []; f.manifest.kitUpdates = [{ id: kit.id, version: kit.version, directory: kitDir, files }]; await f.save();
  for (const [name, value] of Object.entries({ 'toolkit.json': { stateDirectory: f.root }, 'package.json': {}, 'package-lock.json': {} })) await fs.writeFile(path.join(f.root, name), JSON.stringify(value), 'utf8');
  const calls = []; let version = ['prepared-only', 'conflict', 'not-installed'].includes(scenario) ? '1.0.0' : '0.1.0', activated = false;
  const server = createServer((req, res) => {
    calls.push(req.url); res.setHeader('content-type', 'application/json');
    if (scenario === 'conflict' && req.url.endsWith('/prepare')) { res.statusCode = 409; res.end(JSON.stringify({ error: { message: 'A different artifact already uses this version.' } })); return; }
    if (req.url.endsWith('/restart')) { version = '1.0.0'; activated = true; }
    const installed = !['prepared-only', 'not-installed'].includes(scenario) || activated && scenario !== 'not-installed';
    res.end(JSON.stringify({ features: [{ id: 'example', version, installed }], errors: [] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const status = { phase: scenario === 'stopped' ? 'stopped' : 'running', managerUrl: `http://127.0.0.1:${server.address().port}/` }, actions = [];
  const work = applyDeployment(f.configPath, { request: async (_, action) => { actions.push(action); return status; }, run: async (_, args) => { assert.equal(scenario, 'stopped'); assert.equal(args[1], 'start'); status.phase = 'running'; return { stdout: '', stderr: '' }; } });
  if (['conflict', 'not-installed'].includes(scenario)) {
    await assert.rejects(work, /different artifact|Loaded Kit version/);
    assert.ok((await fs.readdir(f.root)).includes('pending-deployment.json')); continue;
  }
  const result = await work;
  assert.equal(result.hot, true); assert.deepEqual(actions, ['status', 'status']);
  assert.deepEqual(calls, ['/plugins/features/api/state', '/plugins/features/api/' + (scenario === 'prepared-only' ? 'prepare-install' : 'prepare'), '/plugins/features/api/restart']);
  assert.equal((await fs.readdir(f.root)).includes('pending-deployment.json'), false);
  }
});
test('a cold offline deployment installs Core, prepares entries and starts an isolated real host', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(), run = promisify(execFile), stateDirectory = path.join(f.root, 'state');
  const powershellPath = path.join(process.env.ProgramFiles, 'PowerShell/7/pwsh.exe');
  await fs.mkdir(stateDirectory);
  await fs.writeFile(f.configPath, JSON.stringify({ stateDirectory, powershellPath, plugins: [{ module: 'codex-toolkit-core/kit-runtime', options: { artifacts: [] } }] }), 'utf8');
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'toolkit-offline-fixture', private: true }), 'utf8');
  await fs.writeFile(path.join(f.root, 'package-lock.json'), JSON.stringify({ name: 'toolkit-offline-fixture', lockfileVersion: 3, packages: {} }), 'utf8');
  const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const { stdout } = await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', f.root], { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true, encoding: 'utf8' });
  const packed = JSON.parse(stdout)[0], archive = path.join(f.root, packed.filename);
  const originalConfig = await fs.readFile(f.configPath), nextConfig = path.join(f.root, 'next.json');
  await fs.writeFile(nextConfig, JSON.stringify({ ...JSON.parse(originalConfig.toString('utf8')), preparedSetting: true }), 'utf8');
  f.manifest.config = { path: nextConfig, sha256: createHash('sha256').update(await fs.readFile(nextConfig)).digest('hex'), originalSha256: createHash('sha256').update(originalConfig).digest('hex') };
  f.manifest.artifacts = [{ name: packed.name, version: packed.version, path: archive, sha256: createHash('sha256').update(await fs.readFile(archive)).digest('hex') }]; await f.save();
  t.after(async () => { if ((await requestRuntime(stateDirectory, 'status')).phase !== 'stopped') await requestRuntime(stateDirectory, 'stop', { applicationExited: true }); });
  let guarded = false;
  let failPrepare = true;
  const failure = new Error('fixture failure after configuration was installed');
  const dependencies = { run: async (exe, args, options) => {
    // This isolated fixture has no application. The real process guard has its own PowerShell test.
    if (args.includes('-AssertExited')) { guarded = true; return { stdout: '', stderr: '' }; }
    if (args[1] === 'prepare' && failPrepare) { failPrepare = false; throw failure; }
    return run(exe, args, options);
  } };
  await assert.rejects(applyDeployment(f.configPath, dependencies), error => error === failure);
  assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).preparedSetting, true);
  assert.ok(await readDeployment(f.configPath));
  const result = await applyDeployment(f.configPath, dependencies);
  assert.equal(guarded, true); assert.equal(result.hot, false); assert.equal(result.applied, true);
  assert.equal((await requestRuntime(stateDirectory, 'status')).phase, 'running');
  const entries = JSON.parse(await fs.readFile(path.join(f.root, '.toolkit-entries.json'), 'utf8'));
  assert.equal(Object.keys(entries.files).length, 5);
  assert.match(await fs.readFile(path.join(f.root, 'start-toolkit.ps1'), 'utf8'), /node_modules[\\/]codex-toolkit-core[\\/]src[\\/]start-toolkit.ps1/);
});
