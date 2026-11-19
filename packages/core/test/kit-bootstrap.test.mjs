import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import featureRuntimePlugin from '../src/feature-runtime.mjs';
import { featureModule } from '../src/features.mjs';
import { startRuntime } from '../src/runtime.mjs';

test('the starter config installs one local Kit through the real manager', { skip: process.platform !== 'win32' }, async t => {
  const config = JSON.parse(await fs.readFile(new URL('../../../examples/kit-manager/toolkit.example.json', import.meta.url), 'utf8'));
  assert.equal(config.plugins.length, 1);
  assert.equal(config.plugins[0].module, 'codex-toolkit-core/kit-runtime');
  assert.deepEqual(config.plugins[0].options.artifacts, []);
  assert.deepEqual(config.plugins[0].options.enabled, []);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codextopkits-bootstrap-'));
  let runtime;
  t.after(async () => { await runtime?.close(); await fs.rm(root, { recursive: true }); });
  const directory = path.join(root, 'fixture'), manifest = { id: 'sample', version: '0.1.0', entry: 'index.mjs', coreApiVersion: 1, dependencies: {} };
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'kit.json'), JSON.stringify(manifest), 'utf8');
  await fs.writeFile(path.join(directory, 'index.mjs'), featureModule({ manifest, create: () => ({ close() {} }) }), 'utf8');
  const errors = [];
  runtime = await startRuntime({ stateDirectory: path.join(root, 'state'), plugins: [featureRuntimePlugin(config.plugins[0].options)], onError: error => errors.push(error) });
  const base = new URL('plugins/features/', runtime.status().managerUrl);
  const request = async (route, body) => {
    const response = await fetch(new URL('api/' + route, base), body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-toolkit-action': 'manage' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const initial = await request('state'); assert.equal(initial.features.length, 0);
  const prepared = await request('prepare-install', { directory }); assert.equal(prepared.features[0].installed, false);
  const applied = await request('restart', {});
  assert.deepEqual(applied.features.map(value => [value.id, value.version, value.enabled]), [['sample', '0.1.0', true]]);
  assert.equal(applied.stablePid, initial.stablePid); assert.notEqual(applied.hostPid, initial.hostPid);
  assert.deepEqual(errors, []);
});
