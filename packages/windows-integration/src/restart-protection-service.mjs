import { createRestartProtection } from './restart-protection.mjs';

export const serviceApiVersion = '1.0.0';
export default async function createRestartProtectionService({ legacyPlugin, powershellPath = 'pwsh.exe' } = {}, context, overrides = {}) {
  const lifetime = new AbortController();
  let protection, protect;
  if (legacyPlugin) {
    const owner = context.getPlugin?.(legacyPlugin);
    if (typeof owner?.protectRestart !== 'function') throw new Error('Legacy Windows module does not support update protection handoff.');
    protect = () => owner.protectRestart();
  } else {
    if (!Number.isInteger(context.cdpPort) || context.cdpPort < 1 || context.cdpPort > 65535) throw new Error('Update protection requires the active CDP port from Core 0.3.19 or later.');
    const processId = (await context.cdp.send('SystemInfo.getProcessInfo')).processInfo.find(value => value.type === 'browser')?.id;
    if (!Number.isInteger(processId) || processId < 1) throw new Error('Codex main process identity is unavailable.');
    protection = (overrides.createRestartProtection || createRestartProtection)({ processId, port: context.cdpPort, powershellPath, signal: lifetime.signal, log: context.log });
    protect = () => protection.protect();
  }
  return { snapshot: () => ({}), configure() {}, removeTarget() {},
    async receive(targetId, value) {
      if (value.kind !== 'restart-protection') return false;
      if (typeof value.requestId !== 'string' || !value.requestId) throw new TypeError('Invalid update protection request identity.');
      let result, error;
      try { result = await protect(); }
      catch (failure) { error = { name: failure.name, message: failure.message, stack: failure.stack, code: failure.code }; }
      const args = [value.requestId, result ?? null, error ?? null].map(item => JSON.stringify(item)).join(',');
      try { await context.evaluatePage(targetId, 'window.__CODEXTOPKITS_RESTART_PROTECTION__?.resolve(' + args + ')'); }
      catch (failure) { if (failure.code !== 'CDP_TARGET_CLOSED') throw failure; }
      return true;
    },
    async close() { lifetime.abort(new Error('Update protection service stopped.')); await Promise.allSettled([protection?.settled()]); },
  };
}
