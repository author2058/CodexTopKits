import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const serviceApiVersion = '1.0.0';
export default async function createRoleModelService(_options, context) {
  let backend, backendPath, stopped = false;
  const receipts = new Map();
  const changed = () => { if (!stopped) void context.notify().catch(error => context.reportError(error, 'notify')); };
  return {
    snapshot: targetId => { const value = backend?.snapshot(); return { roleModels: value ? { ...value, error:value.error?.message || null, receipt:receipts.get(targetId) || null } : null }; },
    async configure(ids, catalog = []) {
      if (!ids.includes('role-model-selection')) { await backend?.close(); backend = null; backendPath = null; return; }
      const artifact = catalog.find(row => row.manifest.id === 'role-model-selection');
      if (!artifact?.manifest.backendEntry) throw new Error('Role model Kit backend is missing.');
      const filename = path.join(artifact.directory, artifact.manifest.backendEntry);
      if (filename === backendPath) return;
      await backend?.close(); backend = null;
      const module = await import(pathToFileURL(filename).href);
      backend = await module.openRoleModelBackend({ filename: path.join(context.stateDirectory, 'roles.json'), onChange: changed, onError: error => context.reportError(error, 'recommendations') });
      backendPath = filename;
      if (!backend.snapshot().recommendationsValidated) {
        const current=backend;
        void current.refresh().then(() => { if(!stopped&&backend===current)context.reportError(null,'recommendations'); }).catch(error => { if(!stopped&&backend===current)context.reportError(error,'recommendations'); });
      }
    },
    async receive(targetId, action) {
      if (action.kind !== 'role-model-action') return false;
      if (!backend || typeof action.requestId !== 'string') throw new Error('Role model settings service is unavailable.');
      try {
        if (action.operation === 'assign') await backend.assign(action.value);
        else if (action.operation === 'policy') { await backend.savePolicy(action.value); if (!backend.snapshot().error) context.reportError(null,'recommendations'); }
        else if (action.operation === 'refresh') { await backend.refresh(); context.reportError(null, 'recommendations'); }
        else throw new TypeError('Unknown role model operation.');
        receipts.set(targetId, { requestId: action.requestId, ok: true }); context.reportError(null, 'action:' + targetId);
      } catch (error) {
        receipts.set(targetId, { requestId: action.requestId, ok: false, message: error.message }); context.reportError(error, 'action:' + targetId);
      }
      await context.notify(); return true;
    },
    removeTarget(targetId) { receipts.delete(targetId); context.reportError(null, 'action:' + targetId); },
    async close() { stopped = true; await backend?.close(); receipts.clear(); },
  };
}
