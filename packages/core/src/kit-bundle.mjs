import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { kitAssetPaths } from './features.mjs';

const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
const filenames = manifest => {
  if (manifest.entry !== 'index.mjs' || manifest.backendEntry !== undefined && manifest.backendEntry !== 'backend.mjs') throw new Error('Invalid Kit entry in bundle.');
  return ['kit.json', manifest.entry, manifest.backendEntry, ...kitAssetPaths(manifest)].filter(Boolean);
};

export async function createKitBundle(directory, manifest) {
  const files = {};
  for (const name of filenames(manifest)) files[name] = (await fs.readFile(path.join(directory, name))).toString('base64');
  return gzipSync(Buffer.from(JSON.stringify({ format: 'codextopkits-kit-1', files }), 'utf8'));
}

export async function unpackKitBundle(bytes, directory, { id, version }) {
  const bundle = decode(gunzipSync(bytes));
  if (bundle?.format !== 'codextopkits-kit-1' || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) throw new Error('Invalid Kit bundle.');
  const read = name => {
    const value = bundle.files[name];
    if (typeof value !== 'string') throw new Error('Missing Kit bundle file: ' + name);
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) throw new Error('Invalid Kit bundle encoding: ' + name);
    return decoded;
  };
  const manifest = decode(read('kit.json'));
  if (manifest.id !== id || manifest.version !== version) throw new Error('Kit bundle identity does not match the selected update.');
  const names = filenames(manifest), supplied = Object.keys(bundle.files);
  if (names.length !== supplied.length || names.some(name => !Object.hasOwn(bundle.files, name))) throw new Error('Kit bundle files do not match its manifest.');
  const contents = names.map(name => [name, read(name)]);
  for (const [name, value] of contents) {
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value, { flag: 'wx' });
  }
  return manifest;
}
