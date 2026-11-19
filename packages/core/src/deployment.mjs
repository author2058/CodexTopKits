import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { requestRuntime } from './runtime.mjs';
import { fileURLToPath } from 'node:url';
import { withDeploymentLease } from './deployment-lock.mjs';
import { readKitArtifacts } from './feature-runtime.mjs';

const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readDeployment(configPath, { filename = path.join(path.dirname(configPath), 'pending-deployment.json') } = {}) {
  const root = path.dirname(configPath);
  let manifest;
  try { manifest = decode(await fs.readFile(filename)); }
  catch (error) { if (error.code === 'ENOENT' && error.path === filename) return null; throw error; }
  if (manifest.version !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceRevision || '') || manifest.review?.outcome !== 'PASS'
    || manifest.review.head !== manifest.sourceRevision || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.kitUpdates)) throw new Error('The prepared deployment has no matching approved source revision.');
  const checked = async (filename, sha256) => {
    if (!path.isAbsolute(filename || '') || !/^[a-f0-9]{64}$/.test(sha256 || '') || checksum(await fs.readFile(filename)) !== sha256) throw new Error('Prepared deployment checksum does not match: ' + filename);
  };
  for (const item of manifest.artifacts) {
    if (!/^[a-z][a-z0-9-]+$/.test(item.name || '') || !/^\d+\.\d+\.\d+$/.test(item.version || '')) throw new Error('Invalid prepared package identity.');
    await checked(item.path, item.sha256);
  }
  for (const item of manifest.kitUpdates) {
    const kit = decode(await fs.readFile(path.join(item.directory, 'kit.json')));
    if (kit.id !== item.id || kit.version !== item.version || !item.files || !Object.hasOwn(item.files, 'kit.json') || !Object.hasOwn(item.files, kit.entry)) throw new Error('Prepared Kit identity does not match: ' + item.id);
    for (const [file, hash] of Object.entries(item.files)) {
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Invalid prepared Kit file.');
      await checked(path.join(item.directory, file), hash);
    }
  }
  if (manifest.config) {
    await checked(manifest.config.path, manifest.config.sha256); decode(await fs.readFile(manifest.config.path));
    if (![manifest.config.originalSha256, manifest.config.sha256].includes(checksum(await fs.readFile(configPath)))) throw Object.assign(new Error('Toolkit settings changed after this update was prepared. Prepare the update again before restarting.'), { code: 'DEPLOYMENT_CONFIG_CHANGED' });
  }
  const candidateConfig = decode(await fs.readFile(manifest.config?.path || configPath));
  const coreVersion = manifest.artifacts.find(item => item.name === 'codex-toolkit-core')?.version;
  for (const plugin of candidateConfig.plugins || []) {
    if (['codex-toolkit-core/kit-runtime', 'codex-toolkit-core/feature-runtime'].includes(plugin.module)) await readKitArtifacts(plugin.options?.artifacts || [], { coreVersion });
  }
  return { root, filename, manifest };
}

export async function applyDeployment(configPath, dependencies) {
  return withDeploymentLease(configPath, () => applyDeploymentOwned(configPath, dependencies));
}
async function applyDeploymentOwned(configPath, { run = promisify(execFile), request = requestRuntime, wait = delay } = {}) {
  const deployment = await readDeployment(configPath);
  if (!deployment) return { applied: false };
  const { root, filename, manifest } = deployment;
  const config = decode(await fs.readFile(configPath)), stateDirectory = path.resolve(root, config.stateDirectory);
  const hot = !manifest.requiresRestart && manifest.artifacts.length === 0 && !manifest.config;
  if (!hot) await run(config.powershellPath, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./application-process.ps1', import.meta.url)), '-AssertExited'], { windowsHide: true, encoding: 'utf8' });
  const runtime = await request(stateDirectory, 'status');
  if (!hot && runtime.phase !== 'stopped') {
    await request(stateDirectory, 'stop', { applicationExited: true });
    const deadline = Date.now() + 60000;
    // The runtime responds after closing its resources; wait for its process to release files too.
    while (true) {
      try { process.kill(runtime.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
      if (Date.now() >= deadline) throw new Error('Toolkit has closed its services but its process has not exited within 60 seconds.');
      await wait(100);
    }
  }
  const backup = path.join(stateDirectory, 'deployments', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(backup, { recursive: true });
  for (const name of ['toolkit.json', 'package.json', 'package-lock.json']) {
    await fs.copyFile(path.join(root, name), path.join(backup, name));
  }
  if (manifest.artifacts.length) {
    const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const result = await run(process.execPath, [npm, 'install', '--offline', '--ignore-scripts', '--strict-peer-deps', '--save-exact', '--no-audit', '--no-fund', ...manifest.artifacts.map(item => item.path)], { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    await fs.writeFile(path.join(backup, 'install.log'), result.stdout + result.stderr, 'utf8');
  }
  for (const item of manifest.artifacts) {
    const installed = decode(await fs.readFile(path.join(root, 'node_modules', item.name, 'package.json')));
    if (installed.version !== item.version) throw new Error('Installed version does not match: ' + item.name);
  }
  if (manifest.config) {
    const currentHash = checksum(await fs.readFile(configPath));
    if (![manifest.config.originalSha256, manifest.config.sha256].includes(currentHash)) throw new Error('Toolkit settings changed while the update was installing; the new settings were preserved.');
    if (currentHash !== manifest.config.sha256) await fs.copyFile(manifest.config.path, configPath);
  }
  const cli = path.join(root, 'node_modules/codex-toolkit-core/src/cli.mjs');
  if (!hot) {
    await run(process.execPath, [cli, 'prepare', configPath], { cwd: root, windowsHide: true, encoding: 'utf8' });
    await run(process.execPath, [cli, 'start', configPath], { cwd: root, windowsHide: true, encoding: 'utf8' });
  } else if (runtime.phase === 'stopped') {
    await run(process.execPath, [cli, 'start', configPath], { cwd: root, windowsHide: true, encoding: 'utf8' });
  }
  const after = await request(stateDirectory, 'status');
  if (after.phase !== 'running') throw new Error('Start CodexTopKits before applying a hot Kit update.');
  const api = async (route, body) => {
    const response = await fetch(new URL('plugins/features/api/' + route, after.managerUrl), body === undefined ? { redirect: 'error' } : { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-codex-toolkit-action': 'manage' }, body: JSON.stringify(body) });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error?.message || 'Kit deployment failed.'), value.error); return value;
  };
  let selection = await api('state');
  let prepared = false;
  for (const item of manifest.kitUpdates) {
    const installed = selection.features.find(kit => kit.id === item.id);
    // The existing updater verifies immutable bytes even for a same-version candidate.
    selection = await api(installed?.installed === true ? 'prepare' : 'prepare-install', { id: item.id, directory: item.directory });
    prepared = true;
  }
  if (prepared) selection = await api('restart', {});
  for (const item of manifest.kitUpdates) if (!selection.features.some(kit => kit.installed === true && kit.id === item.id && kit.version === item.version)) throw new Error('Loaded Kit version does not match: ' + item.id);
  const result = { applied: true, hot, at: new Date().toISOString(), sourceRevision: manifest.sourceRevision, artifacts: manifest.artifacts.map(({ name, version }) => ({ name, version })), kits: manifest.kitUpdates.map(({ id, version }) => ({ id, version })), backup };
  await fs.writeFile(path.join(backup, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  await fs.rename(filename, path.join(backup, 'deployment.json'));
  return result;
}
