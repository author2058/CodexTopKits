import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import createImageReferenceKitService from '../src/image-reference-kit-service.mjs';
import createTrafficObserverKitService from '../src/traffic-observer-kit-service.mjs';
import createImagePolicyKitService from '../src/image-policy-kit-service.mjs';

test('active Kit services reuse backends and recreation restores released transient state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-kit-reconnect-')); t.after(() => fs.rm(root, { recursive: true }));
  const build = async (id, source) => { const directory = path.join(root, id); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'backend.mjs'), source, 'utf8'); return { directory, manifest: { id, backendEntry: 'backend.mjs' } }; };
  const image = await build('image-reference-dedup', 'export async function createImageReferenceTransform() {}');
  const traffic = await build('traffic-observer', 'export async function createTrafficService() {}');
  const policy = await build('image-policy-rules', 'export async function installImageIntegration() {} export async function removeImageIntegration() {}');
  await fs.mkdir(path.join(policy.directory, 'src')); await fs.writeFile(path.join(policy.directory, 'src', 'check-codex-image-policy.mjs'), 'export function discoverDesktopCodex() {} export function checkCodexImagePolicy() {}', 'utf8');
  let imagePath = null, trafficPath = null, policyPath = null, imageSwaps = 0, trafficSwaps = 0, policySwaps = 0, removed = 0;
  const owner = {
    imageReferenceControl: () => ({ handedOff: true, backendPath: imagePath }), async setImageReferenceTransform(_factory, value) { imagePath = value; imageSwaps++; }, async disableImageReferenceTransform() { imagePath = null; removed++; },
    trafficObserverControl: () => ({ handedOff: true, backendPath: trafficPath }), async setTrafficObserver(_factory, value) { trafficPath = value; trafficSwaps++; }, async disableTrafficObserver() { trafficPath = null; removed++; },
    imagePolicyControl: () => ({ handedOff: true, stateDirectory: root, backendPath: policyPath }), async setImagePolicyChecker(_adapter, install, value) { await install(); policyPath = value; policySwaps++; }, async resetImagePolicyChecker(remove) { await remove(); policyPath = null; removed++; },
  };
  const context = { getPlugin: () => owner }, options = { codexHome: root, nodeExecutable: process.execPath };
  for (const [id, artifact, create] of [['image-reference-dedup', image, createImageReferenceKitService], ['traffic-observer', traffic, createTrafficObserverKitService], ['image-policy-rules', policy, createImagePolicyKitService]]) {
    const first = await create(options, context); await first.configure([id], [artifact]);
    const active = [imageSwaps, trafficSwaps, policySwaps, removed];
    await first.configure([id], [artifact]);
    assert.deepEqual([imageSwaps, trafficSwaps, policySwaps, removed], active, id + ' reuses its active backend');
    await first.close();
    const recreated = await create(options, context); await recreated.configure([id], [artifact]); await recreated.configure([], []); await recreated.close();
  }
  assert.deepEqual([imageSwaps, trafficSwaps, policySwaps, removed], [2, 1, 1, 4]);
});
