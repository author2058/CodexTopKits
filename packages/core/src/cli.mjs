#!/usr/bin/env node
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startRuntime, requestRuntime } from './runtime.mjs';
import { launchToolkit } from './launch.mjs';
import { prepareEntries } from './prepare-entry.mjs';
import { startAppRestart } from './restart.mjs';
import { quitNativeApplication } from './quit-native.mjs';
import { readDeployment, applyDeployment } from './deployment.mjs';
import { createLocalization } from './localization.mjs';

const [action, filename] = process.argv.slice(2);
const applicationExited = action === 'stop' && process.argv.length === 5 && process.argv[4] === '--application-exited';
const oneTimeRestart = action === 'launch' && process.argv.length === 5 && process.argv[4] === '--one-time-restart';
if (!['prepare', 'start', 'serve', 'status', 'check', 'stop', 'environment', 'launch', 'restart', 'quit-native', 'deployment-check', 'deployment-apply'].includes(action) || !filename || (process.argv.length !== 4 && !applicationExited && !oneTimeRestart)) {
  console.error('Use: codex-toolkit prepare|start|serve|status|check|stop|environment|launch|restart|quit-native|deployment-check|deployment-apply CONFIG.json [--application-exited]');
  process.exitCode = 1;
} else {
  try {
    const configPath = path.resolve(filename);
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(configPath)));
    if (typeof config.stateDirectory !== 'string' || !config.stateDirectory) throw new Error('The configuration requires stateDirectory.');
    const stateDirectory = path.resolve(path.dirname(configPath), config.stateDirectory);
    if (action === 'prepare') {
      console.log(JSON.stringify(await prepareEntries({ configPath, powershellPath: config.powershellPath })));
    } else if (action === 'start') {
      await fs.mkdir(stateDirectory, { recursive: true });
      const output = openSync(path.join(stateDirectory, 'runtime-stdout.log'), 'a');
      const errors = openSync(path.join(stateDirectory, 'runtime-stderr.log'), 'a');
      try {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', configPath], {
          detached: true, windowsHide: true, stdio: ['ignore', output, errors, 'ipc'],
        });
        const ready = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => reject(new Error('Toolkit exited before ready: ' + (code ?? signal))));
          child.once('message', message => message.ready ? resolve(message) : reject(Object.assign(new Error(message.error?.message), message.error)));
        });
        child.disconnect(); child.unref();
        console.log(JSON.stringify(ready));
      } finally { closeSync(output); closeSync(errors); }
    } else if (action === 'serve') {
      const plugins = [];
      for (const item of config.plugins ?? []) {
        if (typeof item.module !== 'string') throw new Error('Each plugin requires an installed module name.');
        const module = await import(item.module);
        if (typeof module.default !== 'function') throw new Error('The plugin has no default factory: ' + item.module);
        plugins.push(module.default(item.options ?? {}));
      }
      const runtime = await startRuntime({ stateDirectory, plugins });
      const stop = () => { void runtime.close().catch(error => { console.error(error); process.exitCode = 1; }); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      if (process.send) process.send({ ready: true, ...runtime.status() });
      else {
        const localization = createLocalization(), status = runtime.status();
        const locale = localization.resolve(status.languagePreference, [status.hostLanguage, status.systemLanguage]);
        console.log(localization.translate({ en: { ready: 'CodexTopKits is ready. State and logs: {directory}' }, 'zh-Hans': { ready: 'CodexTopKits 已就绪。状态与日志目录：{directory}' } }, locale, 'ready', { directory: stateDirectory }));
      }
    } else if (action === 'restart') {
      console.log(JSON.stringify(await startAppRestart({ configPath, powershellPath: config.powershellPath })));
    } else if (action === 'quit-native') {
      console.log(JSON.stringify(await quitNativeApplication(stateDirectory)));
    } else if (action === 'deployment-check') {
      const pending = await readDeployment(configPath);
      console.log(JSON.stringify({ prepared: Boolean(pending), sourceRevision: pending?.manifest.sourceRevision }));
    } else if (action === 'deployment-apply') {
      console.log(JSON.stringify(await applyDeployment(configPath)));
    } else if (action === 'launch') {
      const result = await launchToolkit({ powershellPath: config.powershellPath ?? 'pwsh', stateDirectory, oneTimeRestart });
      console.log(JSON.stringify(result));
    } else {
      const result = await requestRuntime(stateDirectory, action, { applicationExited });
      console.log(JSON.stringify(result));
      if (action === 'check' && !result.health.ok) process.exitCode = 1;
    }
  } catch (error) {
    if (process.send) process.send({ ready: false, error: { name: error.name, message: error.message, code: error.code, stack: error.stack } });
    console.error(error);
    process.exitCode = 1;
    // A failed dedicated runtime must not linger with partially opened resources.
    if (action === 'serve') process.exit(1);
  }
}
