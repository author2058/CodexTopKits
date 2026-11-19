import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HardResetFeed, powerShellHardResetFetch } from './hard-reset.mjs';

export const serviceApiVersion = '1.0.0';
export default async function createScheduledResetService({ legacyPlugin, powershellPath = 'pwsh.exe' } = {}, context, overrides = {}) {
  if (legacyPlugin) {
    const owner = context.getPlugin?.(legacyPlugin);
    if (!owner?.featureState || !owner?.onFeatureState || !owner?.startFeatureForecast || !owner?.stopFeatureForecast) throw new Error('Legacy chat module does not support feature handoff.');
    const unsubscribe = owner.onFeatureState(() => { void context.notify(); });
    owner.startFeatureForecast();
    return { snapshot: () => owner.featureState(), configure() {}, receive: () => false, removeTarget() {}, close() { unsubscribe(); owner.stopFeatureForecast(); } };
  }
  const feed = new HardResetFeed({ cachePath: path.join(context.stateDirectory, 'hard-reset.json'), fetchImpl: overrides.fetchImpl
    || powerShellHardResetFetch(promisify(execFile), powershellPath, fileURLToPath(new URL('./fetch-hard-reset-status.ps1', import.meta.url))) });
  let timer, stopped = false;
  const refresh = async () => {
    try { await feed.refresh(); context.reportError(null); } catch (error) { if (!stopped) context.reportError(error); }
    if (stopped) return;
    await context.notify();
    if (!feed.halted) { timer = setTimeout(() => { void refresh(); }, Math.max(0, feed.nextCheckAt - Date.now())); timer.unref(); }
  };
  void refresh().catch(context.reportError);
  return { snapshot: () => ({ hardReset: feed.snapshot() }), configure() {}, receive: () => false, removeTarget() {},
    async close() { stopped = true; clearTimeout(timer); feed.close(); await feed.pending?.catch(() => { /* The feed reports its original transport failure. */ }); } };
}
