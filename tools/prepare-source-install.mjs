#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolveKits } from '../packages/core/src/features.mjs';
import { createGithubKitUpdates } from '../packages/core/src/github-kit-updates.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function readCatalog(root = sourceRoot) {
  const catalog = new Map();
  for (const item of await fs.readdir(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const packageRoot = path.join(root, 'packages', item.name);
    let kits;
    try { kits = await fs.readdir(path.join(packageRoot, 'kits'), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const info = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    for (const kit of kits) {
      if (!kit.isDirectory()) continue;
      const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'kits', kit.name, 'kit.json'), 'utf8'));
      if (catalog.has(manifest.id)) throw new Error('Duplicate Kit ID: ' + manifest.id);
      catalog.set(manifest.id, { manifest, packageRoot, packageName: info.name, folder: kit.name });
    }
  }
  return catalog;
}

export function selectKits(catalog, requested) {
  if (!requested?.length) throw new Error('Select at least one Kit with --kit.');
  const selected = new Map();
  const visit = id => {
    if (selected.has(id)) return;
    const kit = catalog.get(id);
    if (!kit) throw new Error('Unknown Kit: ' + id);
    selected.set(id, kit);
    for (const dependency of Object.keys(kit.manifest.dependencies)) visit(dependency);
  };
  for (const id of requested) visit(id);
  resolveKits([...selected.values()].map(kit => ({ manifest: kit.manifest, create() {} })));
  return [...selected.values()];
}

export function createConfig(kits, { destination, node, powershell, codexHome, openssl, updateRepository = 'author2058/CodexTopKits' }) {
  for (const [name, value] of Object.entries({ destination, node, powershell, ...(codexHome ? { codexHome } : {}), ...(openssl ? { openssl } : {}) })) {
    if (!path.isAbsolute(value ?? '')) throw new Error(name + ' must be an absolute path.');
  }
  createGithubKitUpdates(updateRepository);
  const ids = new Set(kits.map(kit => kit.manifest.id));
  const required = new Set(kits.flatMap(kit => kit.manifest.services || []));
  if ((required.has('context-recovery') || required.has('image-policy')) && !codexHome) throw new Error('The selected Kits require --codex-home.');
  const configPath = path.join(destination, 'toolkit.json');
  const serviceOptions = {
    'theme-settings': { module: 'codex-toolkit-themes/feature-service', options: { legacyPlugin: 'themes' } },
    windows: { module: 'codex-toolkit-windows/feature-service', options: { powershellPath: powershell } },
    awake: { module: 'codex-toolkit-windows/awake-service', options: { powershellPath: powershell } },
    'read-aloud': { module: 'codex-toolkit-windows/read-aloud-service', options: { powershellPath: powershell } },
    'restart-protection': { module: 'codex-toolkit-windows/restart-protection-service', options: { powershellPath: powershell } },
    'scheduled-reset': { module: 'codex-toolkit-chat/feature-service', options: { powershellPath: powershell } },
    'chat-diagnostics': { module: 'codex-toolkit-chat/diagnostic-service' },
    'chat-history': { module: 'codex-toolkit-chat/history-service', ...(codexHome ? { options: { codexHome } } : {}) },
    'app-restart': { module: 'codex-toolkit-core/app-restart-service', options: { configPath, powershellPath: powershell } },
    'session-runtime': { module: 'codex-toolkit-session/model-protection-service', startBeforeCdp: true },
    'role-models': { module: 'codex-toolkit-session/role-model-service' },
    'context-recovery': { module: 'codex-toolkit-session/context-recovery-service', startBeforeCdp: true, options: { codexHome, nodeExecutable: node, powershell } },
    'image-policy': { module: 'codex-bandwidth/image-policy-service', startBeforeCdp: true, options: { codexHome, nodeExecutable: node } },
    'image-reference': { module: 'codex-bandwidth/image-reference-service', startBeforeCdp: true },
    'traffic-observer': { module: 'codex-bandwidth/traffic-observer-service', startBeforeCdp: true },
  };
  const services = {};
  for (const id of required) {
    if (!serviceOptions[id]) throw new Error('No source-install configuration for service: ' + id);
    services[id] = serviceOptions[id];
  }
  const plugins = [];
  if (required.has('theme-settings')) plugins.push({ module: 'codex-toolkit-themes', options: { cdpPort: 'auto', externalKits: ['ui-font-size', 'project-thread-colors', 'profile-panel-shadow'] } });
  if (required.has('session-runtime') || required.has('context-recovery')) plugins.push({ module: 'codex-toolkit-session', options: { cdpPort: 'auto', restoreAgentComposer: false, externalKits: ['agent-model-protection'] } });
  if (['image-policy', 'image-reference', 'traffic-observer'].some(id => required.has(id))) plugins.push({ module: 'codex-bandwidth', options: { powershellPath: powershell, ...(required.has('traffic-observer') ? { cdpPort: 'auto' } : {}), ...(codexHome ? { codexHome } : {}), ...(openssl ? { opensslPath: openssl } : {}), externalKits: ['image-policy-rules', 'image-reference-dedup', 'traffic-observer'] } });
  plugins.push({ module: 'codex-toolkit-core/kit-runtime', options: { artifacts: kits.map(kit => path.join(destination, 'kits', kit.manifest.id + '-' + kit.manifest.version)), enabled: [...ids], services, githubUpdates: { repository: updateRepository } } });
  return { stateDirectory: './state', powershellPath: powershell, plugins };
}

export async function prepareSourceInstall(options, { root = sourceRoot, run = execFileSync } = {}) {
  const kits = selectKits(await readCatalog(root), options.kits);
  const config = createConfig(kits, options);
  const npm = options.npm || path.join(path.dirname(options.node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!path.isAbsolute(npm)) throw new Error('npm must be an absolute path.');
  await fs.access(options.node); await fs.access(options.powershell); await fs.access(npm);
  if (options.openssl) await fs.access(options.openssl);
  try { await fs.mkdir(options.destination); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if ((await fs.readdir(options.destination)).length) throw new Error('Installation destination must be empty.'); }
  const archives = path.join(options.destination, 'packages'), artifacts = path.join(options.destination, 'kits');
  await fs.mkdir(archives); await fs.mkdir(artifacts);
  await fs.writeFile(path.join(options.destination, 'package.json'), JSON.stringify({ name: 'codextopkits-local-install', private: true }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  const packageRoots = new Map([['codex-toolkit-core', path.join(root, 'packages/core')], ...kits.map(kit => [kit.packageName, kit.packageRoot])]);
  const packages = [];
  for (const packageRoot of packageRoots.values()) {
    const output = run(options.node, [npm, 'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', archives], { cwd: packageRoot, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const packed = JSON.parse(output);
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== 'string') throw new Error('Invalid npm pack output.');
    packages.push(path.join(archives, packed[0].filename));
  }
  run(options.node, [npm, 'install', '--save-exact', '--strict-peer-deps', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...packages], { cwd: options.destination, windowsHide: true, stdio: 'inherit' });
  const core = path.join(options.destination, 'node_modules', 'codex-toolkit-core', 'src');
  for (const kit of kits) {
    const entry = path.join(options.destination, 'node_modules', kit.packageName, 'kits', kit.folder, 'index.mjs');
    run(options.node, [path.join(core, 'feature-pack.mjs'), entry, artifacts], { cwd: options.destination, windowsHide: true, stdio: 'inherit' });
  }
  const configPath = path.join(options.destination, 'toolkit.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  run(options.node, [path.join(core, 'cli.mjs'), 'prepare', configPath], { cwd: options.destination, windowsHide: true, stdio: 'inherit' });
  return { configPath, kits: kits.map(kit => kit.manifest.id), packages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { destination: { type: 'string' }, node: { type: 'string' }, powershell: { type: 'string' }, npm: { type: 'string' }, 'codex-home': { type: 'string' }, openssl: { type: 'string' }, 'update-repository': { type: 'string' }, kit: { type: 'string', multiple: true } } });
  const result = await prepareSourceInstall({ destination: values.destination, node: values.node, powershell: values.powershell, npm: values.npm, codexHome: values['codex-home'], openssl: values.openssl, updateRepository: values['update-repository'], kits: values.kit });
  console.log(JSON.stringify(result));
}
