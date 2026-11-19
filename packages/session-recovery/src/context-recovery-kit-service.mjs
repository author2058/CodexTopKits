import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const serviceApiVersion = '1.0.0';
export default async function createContextRecoveryService({ legacyPlugin = 'session', codexHome, powershell, nodeExecutable } = {}, context) {
  const owner = context.getPlugin?.(legacyPlugin), stateDirectory = owner?.rulesStateDirectory;
  if (![stateDirectory, codexHome, powershell, nodeExecutable].every(value => path.isAbsolute(value ?? ''))) throw new Error('Context recovery requires Session and absolute Codex home, PowerShell 7 and Node paths.');
  const options = { codexHome, stateDirectory, powershell, nodeExecutable, preserveRuntime: true, runtimeCliPath: fileURLToPath(new URL('./cli.mjs', import.meta.url)) };
  let backendPath, backend;
  return {
    snapshot: () => ({}),
    async configure(ids, catalog = []) {
      if (!ids.includes('context-recovery-integration')) { if (backend) { await backend.disableRecoveryHook(options); backend = null; backendPath = null; } return; }
      const artifact = catalog.find(value => value.manifest.id === 'context-recovery-integration');
      if (!artifact || artifact.manifest.backendEntry !== 'backend.mjs') throw new Error('Context recovery Kit backend artifact is missing.');
      const nextPath = path.join(artifact.directory, artifact.manifest.backendEntry); if (nextPath === backendPath) return;
      const next = await import(pathToFileURL(nextPath).href);
      if (typeof next.installRules !== 'function' || typeof next.disableRecoveryHook !== 'function') throw new Error('Context recovery Kit backend exports changed.');
      await next.installRules({ ...options, assetRoot: artifact.directory }); backend = next; backendPath = nextPath;
    },
    receive: () => false, removeTarget() {}, close() {},
  };
}
