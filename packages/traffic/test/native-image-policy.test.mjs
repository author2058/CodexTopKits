import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CHECKER_REVISION, compareImagePolicy, checkCodexImagePolicy, evaluateDefaultProfile } from '../src/check-codex-image-policy.mjs';
import { createImagePolicyFixtures } from '../src/native-image-fixtures.mjs';
import { inspectFile } from '../src/image-delivery-audit.mjs';
import { IMAGE_POLICY_ID } from '../src/codex-image-policy.mjs';

test('native policy comparison checks dimensions, codecs and unchanged source bytes', () => {
  const source = { path: 'wide.webp', format: 'webp', width: 4096, height: 64 };
  const image = { format: 'webp', compression: 'lossless', width: 2048, height: 32, byteIdenticalSources: [] };
  const probe = { sources: [source], requests: [{ images: [image] }] };
  assert.deepEqual(compareImagePolicy(probe, 'high'), []);
  assert.equal(compareImagePolicy(probe, 'original').length, 1);
  image.compression = 'lossy';
  assert.equal(compareImagePolicy(probe, 'high').length, 1);
  source.path = 'wide.jpg'; source.format = 'jpeg'; image.format = 'jpeg';
  assert.deepEqual(compareImagePolicy(probe, 'high'), []);
  source.width = 128; source.height = 72; image.width = 128; image.height = 72;
  assert.equal(compareImagePolicy(probe, 'high').length, 1);
  image.byteIdenticalSources = ['wide.jpg'];
  assert.deepEqual(compareImagePolicy(probe, 'high'), []);
});

test('known default profiles are accepted and later changes remain visible', () => {
  const first = evaluateDefaultProfile(['original'], null);
  assert.deepEqual(first, { defaultProfileBaseline: ['original'], defaultProfileChanged: false, failure: null });
  const previous = { identity: { checkerRevision: CHECKER_REVISION, policyId: IMAGE_POLICY_ID }, ...first };
  assert.equal(evaluateDefaultProfile(['original'], previous).failure, null);
  const changed = evaluateDefaultProfile(['high'], previous);
  assert.deepEqual(changed.defaultProfileBaseline, ['original']);
  assert.equal(changed.defaultProfileChanged, true);
  assert.match(changed.failure, /default image budget/);
  assert.match(evaluateDefaultProfile([], previous).failure, /default image budget/);
  assert.equal(evaluateDefaultProfile(['high'], { ...previous, ...changed }).defaultProfileChanged, true);
  assert.equal(evaluateDefaultProfile(['high'], { ...previous, identity: { ...previous.identity, checkerRevision: 0 } }).failure, null);
});

test('all codec fixtures are generated locally at the native policy boundaries', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-policy-fixtures-'));
  const filenames = await createImagePolicyFixtures(directory);
  assert.equal(filenames.length, 21);
  for (const filename of filenames) {
    const actual = await inspectFile(filename);
    const [, width, height] = /-(\d+)x(\d+)\./.exec(filename);
    assert.equal(actual.width, Number(width));
    assert.equal(actual.height, Number(height));
    assert.equal(actual.compression, filename.endsWith('.png') ? 'lossless' : 'lossy');
  }
});

test('the native identity cache avoids launching a process and malformed cache errors stay visible', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-policy-cache-'));
  const executable = path.join(directory, 'synthetic-executable');
  await fs.writeFile(executable, 'fixture', 'utf8');
  const stat = await fs.stat(executable);
  const identity = { executable, bytes: stat.size, mtimeMs: stat.mtimeMs, clientIdentity: null, policyId: IMAGE_POLICY_ID, checkerRevision: CHECKER_REVISION };
  const reportFile = path.join(directory, 'native-policy-check.json');
  await fs.writeFile(reportFile, JSON.stringify({ identity, ok: true, version: 'synthetic', modelCalls: 0 }), 'utf8');
  const cached = await checkCodexImagePolicy({ executable, stateDirectory: directory });
  assert.equal(cached.cached, true);
  assert.equal(cached.modelCalls, 0);
  await fs.writeFile(reportFile, 'INVALID', 'utf8');
  await assert.rejects(checkCodexImagePolicy({ executable, stateDirectory: directory }), SyntaxError);
});
