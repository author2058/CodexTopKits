import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { requestRuntime } from './runtime.mjs';

export async function launchToolkit({ powershellPath = 'pwsh', stateDirectory, oneTimeRestart = false }, { request = requestRuntime, launch = runLaunchHelper } = {}) {
  const runtime = await request(stateDirectory, 'environment');
  const result = await launch({ powershellPath, stateDirectory, oneTimeRestart,
    scriptPath: fileURLToPath(new URL('./launch-codex.ps1', import.meta.url)),
    environment: { ...process.env, ...runtime.environment },
  });
  // A prior reconnect attempt may have expired while the app was closed.
  if (runtime.cdp?.connected === false) {
    const checked = await request(stateDirectory, 'reconnect');
    return { ...result, health: checked.health };
  }
  return result;
}

export async function runLaunchHelper({ powershellPath, scriptPath, environment, stateDirectory, oneTimeRestart = false }) {
  const directory = await fs.mkdtemp(path.join(stateDirectory, 'launch-'));
  const receiptPath = path.join(directory, 'result.json');
  const stderrPath = path.join(directory, 'stderr.log');
  const errors = openSync(stderrPath, 'wx');
  try {
    // The app inherits its helper's handles; pipes would keep the caller waiting until the app exits.
    const child = spawn(powershellPath, ['-NoProfile', '-NonInteractive', '-File', scriptPath, '-ResultPath', receiptPath, '-StateDirectory', stateDirectory, ...(oneTimeRestart ? ['-OneTimeRestart'] : [])], {
      env: environment, windowsHide: true, stdio: ['ignore', 'ignore', errors],
    });
    const [code, signal] = await once(child, 'exit');
    if (code !== 0) {
      const stderr = await fs.readFile(stderrPath, 'utf8');
      throw Object.assign(new Error(stderr.trim() || 'Codex launcher exited: ' + (code ?? signal)), { code, signal, stderrPath });
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(receiptPath)));
  } finally { closeSync(errors); }
}
