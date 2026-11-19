import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dimension rounding adapted from OpenAI Codex (Copyright 2025 OpenAI, Apache-2.0).
// JavaScript adaptation and selector are local changes; license: ../third-party/openai-codex-LICENSE.
// Native rules pinned to the matching source and checked against each installed binary.
export const IMAGE_POLICY_ID = 'codex-image-20261104-1';
export const IMAGE_PROFILES = Object.freeze({
  high: Object.freeze({ maxDimension: 2048, maxPatches: 2500 }),
  original: Object.freeze({ maxDimension: 6000, maxPatches: 10000 }),
});
export const IMAGE_POLICY_SOURCE = {
  tag: 'rust-v0.166.0-alpha.6',
  encoder: 'https://github.com/openai/codex/blob/rust-v0.166.0-alpha.6/codex-rs/utils/image/src/lib.rs',
  preparation: 'https://github.com/openai/codex/blob/rust-v0.166.0-alpha.6/codex-rs/core/src/image_preparation.rs',
};

function checkDimensions(width, height) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Image dimensions must be positive integers.');
}

export function nativeImageDimensions(width, height, profile) {
  checkDimensions(width, height);
  const limits = IMAGE_PROFILES[profile];
  if (!limits) throw new Error('Specify the effective native image profile: high or original.');
  const fits = (w, h) => w <= limits.maxDimension && h <= limits.maxDimension
    && Math.ceil(w / 32) * Math.ceil(h / 32) <= limits.maxPatches;
  if (fits(width, height)) return [width, height];
  const dimensionScale = Math.min(limits.maxDimension / Math.max(width, height), 1);
  width = Math.max(Math.round(width * dimensionScale), 1);
  height = Math.max(Math.round(height * dimensionScale), 1);
  if (fits(width, height)) return [width, height];
  let scale = Math.sqrt(32 * 32 * limits.maxPatches / width / height);
  const pw = width * scale / 32, ph = height * scale / 32;
  scale *= Math.min(Math.floor(pw) / pw, Math.floor(ph) / ph);
  return [Math.max(Math.floor(width * scale), 1), Math.max(Math.floor(height * scale), 1)];
}

export function imageEncodingPlan({ width, height, target = 'local', mode = 'efficient', profile }) {
  checkDimensions(width, height);
  if (!['local', 'model'].includes(target)) throw new Error('Image target must be local or model.');
  if (!['efficient', 'lossless'].includes(mode)) throw new Error('Image mode must be efficient or lossless.');
  // Only the model boundary has a native resize budget; never apply it to local tools.
  const nativeSize = target === 'model' ? nativeImageDimensions(width, height, profile) : null;
  const nativeWillResize = nativeSize !== null && (nativeSize[0] !== width || nativeSize[1] !== height);
  const format = mode === 'lossless' ? 'png' : nativeWillResize ? 'jpeg' : 'webp';
  return { policyId: IMAGE_POLICY_ID, target, mode, profile: target === 'model' ? profile : null,
    format, extension: format === 'jpeg' ? '.jpg' : '.' + format,
    quality: format === 'webp' ? 85 : format === 'jpeg' ? 90 : null,
    width, height, resizeLocally: false, nativeWillResize, nativeSize,
    reason: mode === 'lossless' ? 'preserve-lossless-intent' : nativeWillResize ? 'avoid-native-lossless-webp-reencode' : 'normal-efficient-output' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [width, height, target = 'local', profile, mode = 'efficient'] = process.argv.slice(2);
    console.log(JSON.stringify(imageEncodingPlan({ width: Number(width), height: Number(height), target, profile, mode })));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
