import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSharp } from './load-sharp.mjs';

// Synthetic codec boundaries, generated locally instead of shipping diagnostic images.
const dimensions = [[128, 72], [2048, 64], [2049, 64], [1600, 1600], [1601, 1601],
  [4096, 64], [6000, 64], [6001, 64], [3200, 3200], [3201, 3201]];

export async function createImagePolicyFixtures(directory, { signal, sharpEntry } = {}) {
  const sharp = await loadSharp(sharpEntry);
  await fs.mkdir(directory, { recursive: true });
  const filenames = [];
  for (const [width, height] of dimensions) {
    for (const [format, quality] of [['webp', 85], ['jpeg', 90]]) {
      signal?.throwIfAborted();
      const filename = path.join(directory, `efficient-${width}x${height}.${format === 'jpeg' ? 'jpg' : format}`);
      await sharp({ create: { width, height, channels: 3, background: '#315b86' } })
        .toFormat(format, { quality }).toFile(filename);
      filenames.push(filename);
    }
  }
  signal?.throwIfAborted();
  const png = path.join(directory, 'lossless-2049x64.png');
  await sharp({ create: { width: 2049, height: 64, channels: 3, background: '#315b86' } }).png().toFile(png);
  return [...filenames, png];
}
