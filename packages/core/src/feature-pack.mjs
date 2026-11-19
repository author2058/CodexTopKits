#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { featureModule, kitAssetPaths } from './features.mjs';
import { compareKitVersions } from './github-kit-updates.mjs';

const [entry, destination] = process.argv.slice(2);
try {
  if (!entry || !destination || process.argv.length !== 4) throw new Error('Use: codextopkits-kit-pack ENTRY.mjs OUTPUT_DIRECTORY');
  const entryDirectory = path.dirname(path.resolve(entry));
  let { default: definition } = await import(pathToFileURL(path.resolve(entry)).href);
  const assetNames = kitAssetPaths(definition.manifest), legalAssets = {};
  let packageDirectory;
  if (definition.manifest.license) {
    for (let directory = entryDirectory;; directory = path.dirname(directory)) {
      const filename = path.join(directory, 'package.json');
      try {
        const info = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(filename)));
        if (info.license === definition.manifest.license) packageDirectory = directory;
        break;
      } catch (error) { if (error.code !== 'ENOENT' || error.path !== filename) throw error; }
      if (directory === path.dirname(directory)) break;
    }
  }
  for (const name of ['LICENSE', 'NOTICE']) {
    if (assetNames.some(asset => asset.toLowerCase() === name.toLowerCase())) continue;
    for (const directory of new Set([entryDirectory, packageDirectory].filter(Boolean))) {
      const filename = path.join(directory, name);
      try { await fs.access(filename); legalAssets[name] = pathToFileURL(filename); break; }
      catch (error) { if (error.code !== 'ENOENT' || error.path !== filename) throw error; }
    }
  }
  if (Object.keys(legalAssets).length) definition = { ...definition,
    manifest: { ...definition.manifest, assets: [...assetNames, ...Object.keys(legalAssets)], minimumCoreVersion:
      compareKitVersions(definition.manifest.minimumCoreVersion ?? '0.0.0', '0.3.21') < 0 ? '0.3.21' : definition.manifest.minimumCoreVersion },
    assets: { ...definition.assets, ...legalAssets } };
  const source = featureModule(definition);
  let backend;
  if (definition.manifest.backendEntry !== undefined) {
    if (definition.manifest.backendEntry !== 'backend.mjs' || !definition.backendPath) throw new Error('Invalid Kit backend entry.');
    backend = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(definition.backendPath));
    if (backend.startsWith('\uFEFF')) throw new Error('Kit backend must be UTF-8 without a BOM.');
    backend = backend.replace(/\r\n?/g, '\n');
  }
  const assets = await Promise.all(kitAssetPaths(definition.manifest).map(async name => {
    if (!definition.assets?.[name]) throw new Error('Missing Kit asset source: ' + name);
    const bytes = await fs.readFile(definition.assets[name]);
    if (!/\.(?:mjs|js|md|ps1|psm1|json|txt)$|^(?:LICENSE|NOTICE)$/i.test(name)) return [name, bytes];
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (value.startsWith('\uFEFF')) throw new Error('Kit text assets must be UTF-8 without a BOM: ' + name);
    return [name, value.replace(/\r\n?/g, '\n')];
  }));
  const output = path.resolve(destination, definition.manifest.id + '-' + definition.manifest.version);
  // Never replace an existing artifact, including an incomplete build that needs inspection.
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, definition.manifest.entry), source, { encoding: 'utf8', flag: 'wx' });
  if (backend !== undefined) await fs.writeFile(path.join(output, definition.manifest.backendEntry), backend, { encoding: 'utf8', flag: 'wx' });
  for (const [name, value] of assets) { const target = path.join(output, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, value, { flag: 'wx' }); }
  await fs.writeFile(path.join(output, 'kit.json'), JSON.stringify(definition.manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ id: definition.manifest.id, version: definition.manifest.version, output }));
} catch (error) { console.error(error); process.exitCode = 1; }
