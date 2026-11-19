#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readKitArtifact } from './feature-runtime.mjs';
import { createKitBundle } from './kit-bundle.mjs';

const [entry, destination] = process.argv.slice(2);
try {
  if (!entry || !destination || process.argv.length !== 4) throw new Error('Use: codextopkits-kit-bundle PACKED_KIT_DIRECTORY OUTPUT_DIRECTORY');
  const directory = path.resolve(entry), artifact = await readKitArtifact(directory);
  if (artifact.manifestFile !== 'kit.json') throw new Error('Release bundles require a kit.json manifest.');
  const bytes = await createKitBundle(directory, artifact.manifest);
  const output = path.resolve(destination, artifact.manifest.id + '-v' + artifact.manifest.version + '.kit.gz');
  await fs.writeFile(output, bytes, { flag: 'wx' });
  console.log(JSON.stringify({ id: artifact.manifest.id, version: artifact.manifest.version, output, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
} catch (error) { console.error(error); process.exitCode = 1; }
