import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const serviceApiVersion = '1.1.0';
export default async function createAwakeService({ legacyPlugin, awakeScript, powershellPath = 'pwsh.exe' } = {}, context, overrides = {}) {
  const owner = legacyPlugin ? context.getPlugin?.(legacyPlugin) : null;
  if (legacyPlugin && (!owner?.awakeSettings || !owner?.readAwakeActivity || !owner?.onFeatureActivity || !owner?.onFeatureState)) throw new Error('Windows Integration does not support Awake handoff.');
  const settings = owner?.awakeSettings();
  if (owner && !settings.handedOff) throw new Error('Windows Integration has not handed off Awake.');
  awakeScript = awakeScript ?? settings?.awakeScript;
  powershellPath = settings?.powershellPath ?? powershellPath;
  if (awakeScript != null && !path.isAbsolute(awakeScript)) throw new Error('Awake requires an absolute path to the existing Awake script.');
  if (awakeScript == null && !path.isAbsolute(context.stateDirectory ?? '')) throw new Error('Awake requires an absolute service state directory.');
  const targets = new Set(), backlog = [];
  let bridge, backendPath, bundledWriter, switching = false, timer, stopped = false;
  const hasWindow = () => owner ? owner.featureState().windows.some(row => row.applicable) : targets.size > 0;
  const readActivity = () => {
    if (owner) return owner.readAwakeActivity();
    const targetId = targets.values().next().value;
    if (!targetId) throw new Error('No Codex window is available to read Awake activity.');
    return context.evaluatePage(targetId, 'window.__CODEXTOPKITS_WINDOW_PROBE__.readActivity("codex_awake")');
  };
  const refresh = () => { if (bridge && !switching && !stopped) void bridge.refresh().catch(() => { /* Awake reports the original error. */ }); };
  const updateTimer = () => {
    if (bridge && hasWindow() && !timer) { refresh(); timer = setInterval(refresh, 30000); timer.unref(); }
    else if ((!bridge || !hasWindow()) && timer) { clearInterval(timer); timer = null; }
  };
  const deliver = (method, params) => { void bridge.observe(method, params).catch(() => { /* Awake reports the original error. */ }); };
  const observe = (method, params = {}) => {
    const minimal = { threadId: params.threadId || params.thread?.id, turnId: params.turnId || params.turn?.id, turnStatus: params.turnStatus || params.turn?.status };
    if (!bridge || switching) backlog.push([method, minimal]); else deliver(method, minimal);
  };
  const unsubscribeActivity = owner?.onFeatureActivity(observe), unsubscribeState = owner?.onFeatureState(updateTimer);
  const configure = async (ids, catalog = []) => {
    if (!ids.includes('awake-bridge')) {
      if (!bridge) return;
      switching = true;
      clearInterval(timer); timer = null;
      try {
        if (bridge.running) await bridge.running;
        if (bundledWriter) await bundledWriter({ disable: true });
        await bridge.close(); bridge = null; backendPath = null; bundledWriter = null; backlog.length = 0;
      } catch (error) {
        switching = false;
        for (const [method, params] of backlog.splice(0)) deliver(method, params);
        updateTimer();
        throw error;
      }
      switching = false;
      return;
    }
    const artifact = catalog.find(value => value.manifest.id === 'awake-bridge');
    if (!artifact || artifact.manifest.backendEntry !== 'backend.mjs') throw new Error('Awake Kit backend artifact is missing.');
    if (awakeScript == null && !artifact.manifest.assets?.includes('codex-awake/Update-CodexAwakeState.ps1')) throw new Error('Selected Awake Kit does not contain the bundled writer; select Awake 0.1.4 or configure awakeScript.');
    const nextPath = path.join(artifact.directory, artifact.manifest.backendEntry);
    if (nextPath === backendPath) return;
    const script = awakeScript ?? path.join(artifact.directory, 'codex-awake', 'Update-CodexAwakeState.ps1');
    const stateDirectory = awakeScript == null ? context.stateDirectory : undefined;
    const module = await import(pathToFileURL(nextPath).href);
    if (typeof module.AwakeBridge !== 'function' || typeof module.writeAwakeBatch !== 'function') throw new Error('Awake Kit backend exports changed.');
    if (awakeScript == null && module.supportsAwakeDisable !== true) throw new Error('Selected Awake Kit does not support safe disable; select Awake 0.1.4 or configure awakeScript.');
    const write = batch => (overrides.writeAwakeBatch || module.writeAwakeBatch)(powershellPath, script, batch, stateDirectory);
    const next = new module.AwakeBridge({ readActivity,
      write,
      onHealth: async (error, recovered) => { context.reportError(error, 'awake'); if (recovered) await context.log({ event: 'awake-recovered' }); },
    });
    switching = true;
    try {
      if (bridge?.running) await bridge.running;
      await bridge?.close(); bridge = next; backendPath = nextPath; bundledWriter = awakeScript == null ? write : null;
    } finally {
      switching = false;
      if (bridge) for (const [method, params] of backlog.splice(0)) deliver(method, params);
    }
    const alreadyRunning = Boolean(timer); updateTimer(); if (alreadyRunning && hasWindow()) refresh();
  };
  return {
    snapshot: () => ({}), configure,
    receive(targetId, value) {
      if (owner) return false;
      if (value.kind === 'window-state') { if (value.applicable) targets.add(targetId); else targets.delete(targetId); updateTimer(); }
      else if (value.kind === 'window-activity' && value.hostId === 'local') observe(value.method, value.params);
      return false;
    },
    removeTarget(targetId) { targets.delete(targetId); updateTimer(); },
    async close() { stopped = true; clearInterval(timer); unsubscribeActivity?.(); unsubscribeState?.(); backlog.length = 0; await bridge?.close(); },
  };
}
