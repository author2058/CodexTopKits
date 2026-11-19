import test from 'node:test';
import assert from 'node:assert/strict';
import { imageEncodingPlan, nativeImageDimensions } from '../src/codex-image-policy.mjs';

test('native dimensions use side and ceil-patch limits, not aspect ratio or file size', () => {
  for (const [profile, size, expected] of [
    ['high', [2048, 64], [2048, 64]], ['high', [2049, 64], [2048, 64]],
    ['high', [1600, 1600], [1600, 1600]], ['high', [1601, 1601], [1600, 1600]],
    ['high', [4096, 64], [2048, 32]],
    ['original', [6000, 64], [6000, 64]], ['original', [6001, 64], [6000, 64]],
    ['original', [3200, 3200], [3200, 3200]], ['original', [3201, 3201], [3200, 3200]],
  ]) assert.deepEqual(nativeImageDimensions(...size, profile), expected);
});

test('only model-destined efficient exports that will resize use JPG90, without resizing locally', () => {
  const common = { width: 4096, height: 64 };
  const local = imageEncodingPlan(common);
  assert.equal(local.format, 'webp'); assert.equal(local.nativeSize, null);
  assert.equal(imageEncodingPlan({ ...common, target: 'model', profile: 'high' }).quality, 90);
  assert.equal(imageEncodingPlan({ ...common, target: 'model', profile: 'original' }).format, 'webp');
  for (const mode of ['efficient', 'lossless']) for (const target of ['local', 'model']) {
    const plan = imageEncodingPlan({ ...common, target, mode, profile: 'high' });
    assert.equal(plan.width, common.width); assert.equal(plan.height, common.height);
    assert.equal(plan.resizeLocally, false);
    if (mode === 'lossless') assert.equal(plan.format, 'png');
  }
  assert.throws(() => imageEncodingPlan({ ...common, target: 'model' }), /effective native/);
  assert.throws(() => nativeImageDimensions(0, 32, 'high'), /positive/);
});
