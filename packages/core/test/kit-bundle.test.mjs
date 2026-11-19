import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createKitBundle, unpackKitBundle } from '../src/kit-bundle.mjs';
import { readKitArtifact } from '../src/feature-runtime.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-bundle-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const source = path.join(root, 'source'), output = path.join(root, 'output');
  await fs.mkdir(source); await fs.mkdir(output); await fs.mkdir(path.join(source, 'assets'));
  const manifest = { id: 'fixture', version: '0.1.0', entry: 'index.mjs', backendEntry: 'backend.mjs', assets: ['assets/data.bin'], minimumCoreVersion: '0.3.21', coreApiVersion: 1, dependencies: {} };
  await fs.writeFile(path.join(source, 'kit.json'), JSON.stringify(manifest), 'utf8');
  await fs.writeFile(path.join(source, 'index.mjs'), 'export default {manifest:{},create:()=>({close(){}})};\n', 'utf8');
  await fs.writeFile(path.join(source, 'backend.mjs'), 'export const fixture = true;\n', 'utf8');
  await fs.writeFile(path.join(source, 'assets/data.bin'), Buffer.from([0, 1, 254, 255]));
  return { source, output, manifest };
}

test('Kit bundles preserve exactly the manifest, entry, backend and declared assets', async t => {
  const { source, output, manifest } = await fixture(t), bytes = await createKitBundle(source, manifest);
  assert.deepEqual(await unpackKitBundle(bytes, output, { id: 'fixture', version: '0.1.0' }), manifest);
  assert.deepEqual((await readKitArtifact(output)).manifest, manifest);
  for (const name of ['kit.json', 'index.mjs', 'backend.mjs', 'assets/data.bin']) assert.deepEqual(await fs.readFile(path.join(output, name)), await fs.readFile(path.join(source, name)));
  await assert.rejects(unpackKitBundle(bytes, output, { id: 'fixture', version: '0.1.0' }), { code: 'EEXIST' });
});

test('Kit bundle identity, declared paths and encoding are checked before writing', async t => {
  const { source, output, manifest } = await fixture(t), original = JSON.parse(gunzipSync(await createKitBundle(source, manifest)).toString('utf8'));
  const bundle = value => gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  await assert.rejects(unpackKitBundle(bundle(original), output, { id: 'other', version: '0.1.0' }), /identity/);
  await assert.rejects(unpackKitBundle(bundle({ ...original, files: { ...original.files, '../outside': 'eA==' } }), output, { id: 'fixture', version: '0.1.0' }), /files do not match/);
  await assert.rejects(unpackKitBundle(bundle({ ...original, files: { ...original.files, 'index.mjs': 'not base64!' } }), output, { id: 'fixture', version: '0.1.0' }), /encoding/);
  const unsafe = { ...manifest, assets: ['../outside'] };
  await assert.rejects(unpackKitBundle(bundle({ ...original, files: { ...original.files, 'kit.json': Buffer.from(JSON.stringify(unsafe)).toString('base64') } }), output, { id: 'fixture', version: '0.1.0' }), /Invalid or duplicate/);
  assert.deepEqual(await fs.readdir(output), []);
});

test('bundle CLI creates an independently versioned release asset and refuses overwrite', async t => {
  const { source, output } = await fixture(t);
  const cli = fileURLToPath(new URL('../src/kit-bundle-cli.mjs', import.meta.url));
  const run = () => promisify(execFile)(process.execPath, [cli, source, output], { encoding: 'utf8', windowsHide: true });
  const result = JSON.parse((await run()).stdout);
  assert.equal(path.basename(result.output), 'fixture-v0.1.0.kit.gz');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(run(), error => error.stderr.includes('EEXIST'));
});
