import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { requestRuntime } from './runtime.mjs';
import { createLocalization } from './localization.mjs';

export async function startAppRestart({ configPath, powershellPath, nodeExecutable = process.execPath }, { execute = promisify(execFile), request = requestRuntime } = {}) {
  if (!path.isAbsolute(configPath || '') || !path.isAbsolute(powershellPath || '') || !path.isAbsolute(nodeExecutable)) throw new TypeError('Restart requires absolute configuration, PowerShell 7 and Node paths.');
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(configPath)));
  const stateDirectory = path.resolve(path.dirname(configPath), config.stateDirectory);
  const runtime = await request(stateDirectory, 'status');
  const resolvedLocale = runtime.phase === 'running' ? createLocalization().resolve(runtime.languagePreference, [runtime.hostLanguage, runtime.systemLanguage]) : undefined;
  const directory = await fs.mkdtemp(path.join(stateDirectory, 'restart-'));
  const requestPath = path.join(directory, 'request.json');
  await fs.writeFile(requestPath, JSON.stringify({ version: 1, requestedAt: new Date().toISOString(), configPath, powershellPath, nodeExecutable, resolvedLocale }) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await execute(powershellPath, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./start-restart.ps1', import.meta.url)), '-RequestPath', requestPath], { windowsHide: true, encoding: 'utf8' });
  return { accepted: true, directory };
}
