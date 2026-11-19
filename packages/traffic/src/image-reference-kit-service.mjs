import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const serviceApiVersion = '1.0.0';
export default async function createImageReferenceKitService({ legacyPlugin = 'bandwidth' } = {}, context) {
  const owner = context.getPlugin?.(legacyPlugin);
  if (!owner?.imageReferenceControl?.().handedOff || !owner?.setImageReferenceTransform || !owner?.disableImageReferenceTransform) throw new Error('Bandwidth must hand off image reference deduplication before enabling this Kit.');
  let backendPath = owner.imageReferenceControl().backendPath ?? null;
  const disable = async () => { if (backendPath) { await owner.disableImageReferenceTransform(); backendPath = null; } };
  return {
    snapshot: () => ({}),
    async configure(ids, catalog = []) {
      if (!ids.includes('image-reference-dedup')) return disable();
      const artifact = catalog.find(value => value.manifest.id === 'image-reference-dedup');
      if (!artifact || artifact.manifest.backendEntry !== 'backend.mjs') throw new Error('Image reference Kit backend artifact is missing.');
      const next = path.join(artifact.directory, artifact.manifest.backendEntry); if (next === backendPath) return;
      const module = await import(pathToFileURL(next).href);
      if (typeof module.createImageReferenceTransform !== 'function') throw new Error('Image reference Kit backend exports changed.');
      await owner.setImageReferenceTransform(module.createImageReferenceTransform, next); backendPath = next;
    },
    receive: () => false, removeTarget() {}, close: disable,
  };
}
