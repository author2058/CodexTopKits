import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const serviceApiVersion = '1.0.0';
export default async function createTrafficObserverKitService({ legacyPlugin = 'bandwidth' } = {}, context) {
  const owner = context.getPlugin?.(legacyPlugin);
  if (!owner?.trafficObserverControl?.().handedOff || !owner?.setTrafficObserver || !owner?.disableTrafficObserver) throw new Error('Bandwidth must hand off traffic observation before enabling this Kit.');
  let backendPath = owner.trafficObserverControl().backendPath ?? null;
  return {
    snapshot: () => ({}),
    async configure(ids, catalog = []) {
      if (!ids.includes('traffic-observer')) { if (backendPath) { await owner.disableTrafficObserver(); backendPath = null; } return; }
      const artifact = catalog.find(value => value.manifest.id === 'traffic-observer');
      if (!artifact || artifact.manifest.backendEntry !== 'backend.mjs') throw new Error('Traffic observer Kit backend artifact is missing.');
      const next = path.join(artifact.directory, artifact.manifest.backendEntry); if (next === backendPath) return;
      const module = await import(pathToFileURL(next).href);
      if (typeof module.createTrafficService !== 'function') throw new Error('Traffic observer Kit backend exports changed.');
      await owner.setTrafficObserver(module.createTrafficService, next); backendPath = next;
    },
    receive: () => false, removeTarget() {}, close() {},
  };
}
