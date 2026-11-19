import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import footer from '../kits/footer/index.mjs';
import { createKitBundle, unpackKitBundle } from '../src/kit-bundle.mjs';
import { readKitArtifact } from '../src/feature-runtime.mjs';

test('feature pack builds one versioned artifact with no repository-relative imports and refuses overwrite', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-feature-pack-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const cli = fileURLToPath(new URL('../src/feature-pack.mjs', import.meta.url));
  const entry = fileURLToPath(new URL('../kits/footer/index.mjs', import.meta.url));
  const run = () => promisify(execFile)(process.execPath, [cli, entry, directory], { encoding: 'utf8', windowsHide: true });
  const { stdout } = await run(), result = JSON.parse(stdout), output = result.output;
  assert.equal(result.id, 'footer'); assert.equal(path.basename(output), 'footer-' + footer.manifest.version);
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'kit.json'), 'utf8'));
  const { default: definition } = await import(pathToFileURL(path.join(output, manifest.entry)));
  assert.deepEqual(definition.manifest, manifest); assert.equal(typeof definition.helpers.acquireFooter, 'function');
  assert.ok(manifest.assets.includes('LICENSE')); assert.ok(manifest.assets.includes('NOTICE'));
  assert.match(await fs.readFile(path.join(output, 'LICENSE'), 'utf8'), /Apache License/);
  const unpacked = path.join(directory, 'unpacked'); await fs.mkdir(unpacked);
  await unpackKitBundle(await createKitBundle(output, manifest), unpacked, manifest);
  assert.equal(await fs.readFile(path.join(unpacked, 'LICENSE'), 'utf8'), await fs.readFile(path.join(output, 'LICENSE'), 'utf8'));
  const source = await fs.readFile(path.join(output, manifest.entry), 'utf8'); assert.ok(!source.includes('../../src/'));
  await assert.rejects(run(), error => error.stderr.includes('EEXIST'));
  assert.equal(await fs.readFile(path.join(output, manifest.entry), 'utf8'), source);
});

test('Kit-local legal files take precedence, normalize line endings and do not inherit a different package license', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-legal-pack-')); t.after(() => fs.rm(directory, { recursive: true }));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', license: 'Apache-2.0' }), 'utf8');
  await fs.writeFile(path.join(directory, 'LICENSE'), 'Parent license\r\n', 'utf8');
  await fs.writeFile(path.join(directory, 'NOTICE'), 'Parent attribution\r\n', 'utf8');
  const kit = path.join(directory, 'kit'); await fs.mkdir(kit);
  await fs.writeFile(path.join(kit, 'LICENSE'), 'Kit license\r\n', 'utf8');
  const entry = path.join(kit, 'source.mjs');
  const definition = license => `export default {manifest:{id:'legal',version:'0.1.0',entry:'index.mjs',license:${JSON.stringify(license)},coreApiVersion:1,dependencies:{}},create:()=>({close(){}})};\n`;
  await fs.writeFile(entry, definition('Apache-2.0'), 'utf8');
  const cli = fileURLToPath(new URL('../src/feature-pack.mjs', import.meta.url));
  const run = async destination => { await fs.mkdir(destination); return promisify(execFile)(process.execPath, [cli, entry, destination], { encoding: 'utf8', windowsHide: true }); };
  let output = JSON.parse((await run(path.join(directory, 'matching'))).stdout).output;
  assert.equal(await fs.readFile(path.join(output, 'LICENSE'), 'utf8'), 'Kit license\n');
  assert.equal(await fs.readFile(path.join(output, 'NOTICE'), 'utf8'), 'Parent attribution\n');
  assert.equal((await readKitArtifact(output)).manifest.minimumCoreVersion, '0.3.21');
  await fs.writeFile(entry, definition('MIT'), 'utf8');
  output = JSON.parse((await run(path.join(directory, 'different'))).stdout).output;
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'kit.json'), 'utf8'));
  assert.deepEqual(manifest.assets, ['LICENSE']);
  assert.equal(await fs.readFile(path.join(output, 'LICENSE'), 'utf8'), 'Kit license\n');
});

test('a Kit backend is packed alongside its renderer entry', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-backend-pack-')); t.after(() => fs.rm(directory, { recursive: true }));
  const entry = path.join(directory, 'source.mjs'), backend = path.join(directory, 'source-backend.mjs');
  await fs.writeFile(backend, 'export const marker = 42;\n', 'utf8');
  await fs.writeFile(path.join(directory, 'guide.md'), 'one\r\ntwo\r\n', 'utf8');
  await fs.writeFile(path.join(directory, 'support.psm1'), 'function Get-Marker { 42 }\r\n', 'utf8');
  await fs.writeFile(entry, `export default {manifest:{id:'background',version:'0.1.0',entry:'index.mjs',backendEntry:'backend.mjs',assets:['assets/guide.md','assets/support.psm1'],minimumCoreVersion:'0.3.21',coreApiVersion:1,dependencies:{}},create:()=>({close(){}}),backendPath:new URL('./source-backend.mjs',import.meta.url),assets:{'assets/guide.md':new URL('./guide.md',import.meta.url),'assets/support.psm1':new URL('./support.psm1',import.meta.url)}};\n`, 'utf8');
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/feature-pack.mjs', import.meta.url)), entry, directory], { encoding: 'utf8', windowsHide: true });
  const output = JSON.parse(stdout).output; assert.equal(await fs.readFile(path.join(output, 'backend.mjs'), 'utf8'), 'export const marker = 42;\n');
  assert.equal(await fs.readFile(path.join(output, 'assets', 'guide.md'), 'utf8'), 'one\ntwo\n');
  assert.equal(await fs.readFile(path.join(output, 'assets', 'support.psm1'), 'utf8'), 'function Get-Marker { 42 }\n');
});
