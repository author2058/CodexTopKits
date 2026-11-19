import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createNativeBridgeClient, readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import { WindowRegistry } from './window-registry.mjs';
import { NativeWindowWorker } from './native-window.mjs';
import { AutoSleepMonitor, readSleepActivity } from './auto-sleep.mjs';
import { installWindowProbe } from './window-probe.mjs';

export const serviceApiVersion = '1.0.0';
export default async function createWindowsFeatureService({ powershellPath = 'pwsh.exe', enabled = [], legacyPlugin } = {}, context, overrides = {}) {
  if (legacyPlugin) {
    const owner = context.getPlugin?.(legacyPlugin);
    if (!owner?.featureState || !owner?.onFeatureState || !owner?.dispatchFeatureAction) throw new Error('Legacy Windows module does not support feature handoff.');
    let selected = enabled;
    const unsubscribe = owner.onFeatureState(() => { void context.notify(); });
    return { snapshot: () => owner.featureState(), async configure(ids) { selected = ids; if (!ids.includes('auto-sleep') && owner.featureState().autoSleep.enabled) await owner.dispatchFeatureAction({ kind: 'sleep-toggle', enabled: false }); },
      async receive(_targetId, action) {
        if (!['activate', 'sleep-toggle'].includes(action.kind)) return false;
        if (!selected.includes(action.kind === 'activate' ? 'window-tabs' : 'auto-sleep')) throw new Error('The requested footer feature is disabled.');
        await owner.dispatchFeatureAction(action); return true;
      }, removeTarget() {}, close: unsubscribe };
  }
  const { cdp, evaluatePage, notify, log, reportError } = context;
  const processId = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(value => value.type === 'browser')?.id;
  const registry = new WindowRegistry(processId), worker = overrides.worker || new NativeWindowWorker(powershellPath);
  const activity = new Map(); let current = enabled, sleep, stopped = false;
  const publish = async () => { if (!stopped) await notify(); };
  const readActivity = async source => {
    const row = registry.rows()[0]; if (!row) throw new Error('没有可读取会话状态的 Codex 主窗口。');
    return evaluatePage(row.targetId, 'window.__CODEXTOPKITS_WINDOW_PROBE__.readActivity(' + JSON.stringify(source) + ')');
  };
  const configure = async ids => {
    current = ids;
    if (ids.includes('auto-sleep') && !sleep) {
      sleep = new AutoSleepMonitor({ readActivity: () => readActivity('auto_sleep'), checkPower: () => worker.powerStatus(),
        publish: async value => { await log({ event: 'auto-sleep-state', ...value }); await publish(); },
        sleep: overrides.sleep || (() => promisify(execFile)(powershellPath, ['-NoProfile', '-File', fileURLToPath(new URL('./suspend-computer.ps1', import.meta.url))], { encoding: 'utf8', windowsHide: true })),
        onError: error => reportError(error, 'auto-sleep'),
      });
      const monitor = sleep;
      await worker.subscribePower(value => sleep === monitor ? monitor.powerChanged(value) : undefined,
        error => { if (sleep === monitor) void monitor.fail(error); });
      reportError(null, 'auto-sleep');
    }
    if (!ids.includes('auto-sleep') && sleep) { await sleep.setEnabled(false); sleep.close(); sleep = null; reportError(null, 'auto-sleep'); }
  };
  try { await worker.open(); await configure(enabled); }
  catch (error) { sleep?.close(); try { await worker.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Windows feature service startup and cleanup failed.', { cause: error }); } throw error; }
  const capture = async targetId => {
    if (!await evaluatePage(targetId, 'document.hasFocus()')) return;
    const handle = await worker.foreground();
    if (handle && await evaluatePage(targetId, 'document.hasFocus()')) registry.bind(targetId, await worker.placement(handle));
  };
  return {
    configure,
    snapshot: () => ({ windows: registry.rows(), autoSleep: sleep?.status() || { enabled: false, error: null } }),
    pageSource(targetId) {
      registry.add(targetId);
      const helpers = { createNativeBridgeClient, readNativeConversationIdentity, readNativeNotification, readSleepActivity };
      return '(' + installWindowProbe.toString() + ')(window,' + JSON.stringify(targetId) + ',"__CODEXTOPKITS_FEATURE_ACTION__",{'
        + Object.entries(helpers).map(([name, fn]) => JSON.stringify(name) + ':(' + fn.toString() + ')').join(',') + '})';
    },
    async receive(targetId, value) {
      if (value.kind === 'window-state') {
        if (typeof value.applicable !== 'boolean') throw new Error('Invalid native window report.');
        const previous = registry.windows.get(targetId), threadActivity = activity.get(value.taskKey);
        registry.update(targetId, { applicable: value.applicable, taskKey: value.taskKey, title: value.title, color: value.color, focused: value.focused,
          status: threadActivity ? threadActivity.active ? 'active' : 'idle' : value.status, unread: value.focused || previous?.taskKey !== value.taskKey ? false : previous?.unread || false });
        if (value.applicable && value.focused) await capture(targetId);
        if (value.error) reportError(Object.assign(new Error(value.error.message), value.error), 'probe:' + targetId); else reportError(null, 'probe:' + targetId);
        await publish(); return true;
      }
      if (value.kind === 'window-activity') {
        if (value.hostId !== 'local') return true;
        const key = 'local:' + value.params.threadId, start = value.method === 'turn/started' || value.params.status?.type === 'active';
        if (sleep) await sleep.observe(value.method, value.params);
        const previous = activity.get(key), turnId = value.params.turnId;
        if (start && turnId && previous?.turnId === turnId && !previous.active) return true;
        if (!(value.method === 'turn/completed' && turnId && previous?.turnId && turnId !== previous.turnId)) {
          activity.set(key, { active: start, turnId: turnId || previous?.turnId });
          for (const row of registry.rows()) if (row.taskKey === key) { row.status = start ? 'active' : 'idle'; if (value.method === 'turn/completed' && !row.focused) row.unread = true; }
        }
        await publish(); return true;
      }
      if (value.kind === 'activate') {
        if (!current.includes('window-tabs')) throw new Error('Window tabs are disabled.');
        const row = registry.windows.get(value.targetId); if (!row?.applicable) throw new Error('目标 Codex 窗口已经关闭。');
        if (!row.handle) { const handles = await worker.findTarget(value.targetId, processId); if (handles.length !== 1) throw new Error('目标窗口的系统标识不唯一。'); registry.bind(value.targetId, await worker.placement(handles[0])); }
        const result = await worker.focus(row.handle, processId); await log({ event: 'window-activated', targetId: value.targetId, maximized: result.maximized }); reportError(null, 'activate'); return true;
      }
      if (value.kind === 'sleep-toggle') {
        if (!sleep || typeof value.enabled !== 'boolean') throw new Error('Scheduled sleep is disabled or its toggle is invalid.');
        await sleep.setEnabled(value.enabled); reportError(null, 'auto-sleep'); await publish(); return true;
      }
      return false;
    },
    async removeTarget(targetId) { registry.remove(targetId); await publish(); },
    async close() {
      stopped = true; sleep?.close();
      for (const row of registry.windows.values()) {
        try { await evaluatePage(row.targetId, 'window.__CODEXTOPKITS_WINDOW_PROBE__?.close()'); }
        catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') throw error; }
      }
      await worker.close();
    },
  };
}
