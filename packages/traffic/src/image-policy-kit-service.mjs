import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const serviceApiVersion = '1.0.0';
export default async function createImagePolicyKitService({ legacyPlugin = 'bandwidth', codexHome, nodeExecutable } = {}, context) {
  const owner = context.getPlugin?.(legacyPlugin), control = owner?.imagePolicyControl?.();
  if (!control?.handedOff || !path.isAbsolute(control.stateDirectory ?? '') || !path.isAbsolute(codexHome ?? '') || !path.isAbsolute(nodeExecutable ?? '')) throw new Error('Image policy requires Bandwidth handoff and absolute Codex home and Node paths.');
  const sharpEntry = createRequire(import.meta.url).resolve('sharp'), options = { codexHome, stateDirectory: control.stateDirectory, nodeExecutable, sharpEntry };
  let backendPath = control.backendPath ?? null, backend = backendPath ? await import(pathToFileURL(backendPath).href) : null;
  return {
    snapshot: () => ({}),
    async configure(ids, catalog = []) {
      if (!ids.includes('image-policy-rules')) {
        if (backend) { await owner.resetImagePolicyChecker(() => backend.removeImageIntegration(options)); backend = null; backendPath = null; }
        return;
      }
      const artifact = catalog.find(value => value.manifest.id === 'image-policy-rules');
      if (!artifact || artifact.manifest.backendEntry !== 'backend.mjs') throw new Error('Image policy Kit backend artifact is missing.');
      const nextPath = path.join(artifact.directory, artifact.manifest.backendEntry); if (nextPath === backendPath) return;
      const next = await import(pathToFileURL(nextPath).href), checker = await import(pathToFileURL(path.join(artifact.directory, 'src', 'check-codex-image-policy.mjs')).href);
      if (typeof next.installImageIntegration !== 'function' || typeof next.removeImageIntegration !== 'function') throw new Error('Image policy Kit backend exports changed.');
      await owner.setImagePolicyChecker({ discoverDesktopCodex: checker.discoverDesktopCodex, checkCodexImagePolicy: checker.checkCodexImagePolicy, sharpEntry },
        () => next.installImageIntegration({ ...options, assetRoot: artifact.directory }), nextPath);
      backend = next; backendPath = nextPath;
    },
    receive: () => false, removeTarget() {}, close() {},
  };
}
