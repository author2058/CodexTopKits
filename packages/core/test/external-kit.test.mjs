import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readKitArtifact } from '../src/feature-runtime.mjs';
import { FeatureLoader } from '../src/feature-loader.mjs';

test('a Kit from a separate source directory can be packed and loaded through the public contract', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codextopkits-external-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const source = path.join(root, 'third-party'), output = path.join(root, 'output');
  await fs.mkdir(source); await fs.mkdir(output);
  const manifest = { id: 'external-example', version: '1.0.0', entry: 'index.mjs', coreApiVersion: 1, dependencies: {} };
  await fs.writeFile(path.join(source, 'index.mjs'), `export default { manifest: ${JSON.stringify(manifest)}, create: () => ({ close() {} }) };\n`, 'utf8');
  const cli = fileURLToPath(new URL('../src/feature-pack.mjs', import.meta.url));
  const result = JSON.parse((await promisify(execFile)(process.execPath, [cli, path.join(source, 'index.mjs'), output], { encoding: 'utf8', windowsHide: true })).stdout);
  assert.deepEqual((await readKitArtifact(result.output)).manifest, manifest);
  const loader = new FeatureLoader(); t.after(() => loader.close());
  assert.deepEqual(await loader.request('load', { directories: [result.output] }), [manifest]);
  const payload = await loader.request('build', {});
  assert.ok(payload.includes('external-example'));
});
