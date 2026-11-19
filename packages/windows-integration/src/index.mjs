import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { CORE_API_VERSION } from 'codex-toolkit-core';
import { initializePage } from 'codex-toolkit-core/cdp';
import { NativeWindowWorker } from './native-window.mjs';
import { WindowRegistry } from './window-registry.mjs';
import { AutoSleepMonitor } from './auto-sleep.mjs';
import { windowsPayload } from './payload.mjs';
import { createRestartProtection } from './restart-protection.mjs';
import { launchReadAloud } from './read-aloud.mjs';
import { AwakeBridge, writeAwakeBatch } from './awake-bridge.mjs';

const stateKey = '__CODEX_DESKTOP_TOOLKIT_WINDOWS__', bindingName = '__CDTK_WINDOWS_BRIDGE__';
const execFileAsync = promisify(execFile);

export default function windowsPlugin({ cdpPort = 'auto', powershellPath = 'pwsh.exe', awakeScript = null, externalFooter = false, externalKits = [] } = {}, services = {}) {
  if (CORE_API_VERSION !== 1) throw new Error('Windows Integration requires Core API 1.');
  if (awakeScript !== null && !path.isAbsolute(awakeScript)) throw new Error('awakeScript must be an absolute path.');
  if (typeof externalFooter !== 'boolean') throw new TypeError('externalFooter must be boolean.');
  if (!Array.isArray(externalKits) || externalKits.some(id => !['markdown-edge-read-aloud', 'update-restart-protection', 'awake-bridge'].includes(id))) throw new TypeError('Invalid external Windows Kit.');
  return { id: 'windows', coreApiVersion: 1, cdpPort, async start(context) {
    if ((services.platform || process.platform) !== 'win32') throw new Error('窗口集成仅支持 Windows。');
    if (typeof context.cdp?.onReconnect !== 'function' || typeof context.onHostState !== 'function') throw new Error('Windows Integration requires Core 0.3.5 or newer.');
    const lifetime = new AbortController(), epoch = randomUUID(), sessions = new Map(), attaching = new Map(), errors = new Map(), listeners = new Set(), activityListeners = new Set(), captures = new Map();
    let client, registry, worker, protection, connecting, hostState, stopped = false, revision = 0, signature = null, uiSignature = null, delivery = Promise.resolve(), awakeTimer = null;
    const activityTiming = value => { void context.log({ event: 'activity-read-timing', ...value }).catch(error => console.error('Activity timing write failed:', error)); };
    const readActivity = async source => {
      const row = registry?.rows()[0], session = row && sessions.get(row.targetId);
      if (!session) throw new Error('没有可读取会话状态的 Codex 主窗口。');
      const readId = randomUUID(), started = performance.now();
      const timing = { readId, source, targetId: row.targetId, method: 'Runtime.evaluate' };
      activityTiming({ ...timing, status: 'started', elapsedMs: 0 });
      let succeeded = false;
      try {
        const result = await evaluate(session.sessionId, 'window[' + JSON.stringify(stateKey) + '].readSleepActivity(' + JSON.stringify(source) + ',' + JSON.stringify(readId) + ')');
        succeeded = true; return result;
      } finally { activityTiming({ ...timing, status: succeeded ? 'succeeded' : 'failed', elapsedMs: Math.round(performance.now() - started) }); }
    };
    const awake = awakeScript && !externalKits.includes('awake-bridge') ? new AwakeBridge({
      readActivity: () => readActivity('codex_awake'),
      write: batch => (services.writeAwakeBatch || writeAwakeBatch)(powershellPath, awakeScript, batch),
      onHealth: async (error, recovered) => {
        if (error) failed('awake', error);
        else { errors.delete('awake'); if (recovered) await context.log({ event: 'awake-recovered' }); await publish(); }
      },
    }) : null;
    const refreshAwake = () => { void awake.refresh().catch(() => { /* AwakeBridge reports the original error through onHealth. */ }); };
    const sleep = new AutoSleepMonitor({
      readActivity: () => readActivity('auto_sleep'),
      checkPower: async () => { if (!worker) throw new Error('Windows 电源事件接口尚未连接。'); await worker.powerStatus(); },
      publish: async (value, { powerBoundary = false } = {}) => {
        await context.log({ event: 'auto-sleep-state', ...value });
        if (!powerBoundary) await publish();
        else { try { await publish(); } catch (error) { await context.log({ event: 'auto-sleep-power-delivery-failed', name: error.name, message: error.message, stack: error.stack }); } }
      },
      sleep: services.sleep || (async () => {
        await context.log({ event: 'auto-sleep-requested' });
        await execFileAsync(powershellPath, ['-NoProfile', '-File', fileURLToPath(new URL('./suspend-computer.ps1', import.meta.url))], { encoding: 'utf8', windowsHide: true });
        await context.log({ event: 'auto-sleep-returned' });
      }),
      onError: error => failed('auto-sleep', error),
    });
    const reportedErrors = new WeakSet();
    const snapshot = () => ({ revision, autoSleep: sleep.status(), restartProtection: protection?.status(), hostState, windows: registry?.rows() || [], errors: [...errors.values()] });
    const failed = (id, error, targetId) => {
      if (stopped || error.code === 'CDP_TARGET_CLOSED') return;
      reportedErrors.add(error);
      if (errors.get(id)?.message === error.message && errors.get(id)?.name === error.name) return;
      errors.set(id, { id, targetId, name: error.name, message: error.message, stack: error.stack });
      void context.log({ event: 'windows-failed', id, targetId, name: error.name, message: error.message, stack: error.stack }).catch(error => console.error('Windows diagnostic write failed:', error));
      void publish().catch(error => console.error('Windows state delivery failed:', error));
    };
    const evaluate = async (sessionId, expression) => {
      const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    const rendererState = targetId => ({ epoch, targetId, hostState, windows: registry?.rows() || [], autoSleep: sleep.status(), externalFooter, externalKits });
    function publish() {
      if (stopped) return Promise.resolve();
      const value = snapshot(), next = JSON.stringify({ ...value, revision: 0 });
      context.setHealth({ ok: errors.size === 0, issueCount: errors.size, message: errors.size ? [...errors.values()].map(error => error.message).join('; ') : registry?.rows().length ? '窗口集成已连接 ' + registry.rows().length + ' 个主窗口。' : '窗口集成已就绪，等待 Codex 主窗口。',
        issues: [...errors].map(([key, error]) => ({ key, message: error.message })),
        ...(!errors.size ? { messageLocales: { en: registry?.rows().length ? `Window integration connected to ${registry.rows().length} main windows.` : 'Window integration is ready; waiting for a Codex main window.', 'zh-Hans': registry?.rows().length ? '窗口集成已连接 ' + registry.rows().length + ' 个主窗口。' : '窗口集成已就绪，等待 Codex 主窗口。' } } : {}) });
      if (signature !== next) { signature = next; value.revision = ++revision; for (const listener of listeners) listener(value); }
      const ui = JSON.stringify({ windows: value.windows, autoSleep: value.autoSleep, hostState });
      if (uiSignature === ui || !client || client.closed) return delivery;
      uiSignature = ui;
      const payloads = [...sessions].map(([targetId, session]) => [targetId, session.sessionId, JSON.stringify(rendererState(targetId))]);
      const work = delivery.catch(() => { /* The previous caller reports its original failure. */ }).then(async () => {
        if (stopped || client.closed) return;
        let recovered = false;
        await Promise.all(payloads.map(async ([targetId, sessionId, value]) => {
          if (sessions.get(targetId)?.sessionId !== sessionId) return;
          try { await evaluate(sessionId, 'window[' + JSON.stringify(stateKey) + ']?.setState(' + value + ')'); if (errors.delete('delivery:' + targetId)) recovered = true; }
          catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') { failed('delivery:' + targetId, error, targetId); throw error; } }
        }));
        if (payloads.length && errors.delete('delivery')) recovered = true;
        if (recovered) queueMicrotask(() => { void publish().catch(error => failed('delivery', error)); });
      });
      delivery = work; return work;
    }
    const capture = targetId => {
      if (captures.has(targetId)) return captures.get(targetId);
      const task = (async () => {
        const session = sessions.get(targetId);
        if (!session || !worker || !await evaluate(session.sessionId, 'document.hasFocus()')) return false;
        const handle = await worker.foreground();
        if (!handle || !await evaluate(session.sessionId, 'document.hasFocus()')) return false;
        registry.bind(targetId, await worker.placement(handle)); errors.delete('mapping:' + targetId); await publish(); return true;
      })().finally(() => captures.delete(targetId));
      captures.set(targetId, task); return task;
    };
    const activate = async targetId => {
      const row = registry.windows.get(targetId);
      if (!row?.applicable || !sessions.has(targetId)) throw new Error('目标 Codex 窗口已经关闭。');
      const started = Date.now();
      if (!row.handle) {
        const handles = await worker.findTarget(targetId, registry.processId);
        if (handles.length !== 1) throw new Error('目标窗口的系统标识匹配到 ' + handles.length + ' 个窗口，无法安全切换。');
        registry.bind(targetId, await worker.placement(handles[0]));
      }
      const result = await worker.focus(row.handle, registry.processId);
      errors.delete('activate'); await context.log({ event: 'window-activated', targetId, elapsedMs: Date.now() - started, maximized: result.maximized }); await publish();
      return result;
    };
    const install = (targetId, session) => {
      const work = (session.installing || Promise.resolve()).then(async () => {
        if (stopped) return;
        if (session.scriptId) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }, session.sessionId);
        const source = windowsPayload(rendererState(targetId));
        session.scriptId = (await client.send('Page.addScriptToEvaluateOnNewDocument', { source }, session.sessionId)).identifier;
        await evaluate(session.sessionId, source); errors.delete('target:' + targetId);
      });
      session.installing = work.catch(() => { /* Each caller reports its original rejection. */ }); return work;
    };
    const attach = target => {
      if (stopped || target.type !== 'page' || !target.url.startsWith('app://') || sessions.has(target.targetId)) return Promise.resolve();
      if (attaching.has(target.targetId)) return attaching.get(target.targetId);
      const job = (async () => {
        registry.add(target.targetId);
        const session = await initializePage(client, target.targetId, bindingName); sessions.set(target.targetId, session);
        await install(target.targetId, session);
      })().catch(error => failed('target:' + target.targetId, error, target.targetId)).finally(() => attaching.delete(target.targetId));
      attaching.set(target.targetId, job); return job;
    };
    const remove = targetId => {
      registry?.remove(targetId); sessions.delete(targetId);
      for (const [id, error] of errors) if (error.targetId === targetId) errors.delete(id);
      void publish().catch(error => failed('delivery', error));
    };
    const receive = async message => {
      const params = message.params || {};
      if (['Target.targetCreated', 'Target.targetInfoChanged'].includes(message.method)) return attach(params.targetInfo);
      if (message.method === 'Target.targetDestroyed') return remove(params.targetId);
      if (message.method === 'Target.detachedFromTarget') { const row = [...sessions].find(([, value]) => value.sessionId === params.sessionId); if (row) remove(row[0]); return; }
      const entry = [...sessions].find(([, value]) => value.sessionId === message.sessionId); if (!entry) return;
      const [targetId, session] = entry;
      if (message.method === 'Page.frameNavigated' && !params.frame.parentId) return install(targetId, session);
      if (message.method !== 'Runtime.bindingCalled' || params.name !== bindingName) return;
      const value = JSON.parse(params.payload);
      if (value.kind === 'activity-read-timing') {
        if (typeof value.readId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.readId)
          || !['codex_awake', 'auto_sleep'].includes(value.source) || !['thread/loaded/list', 'thread/read'].includes(value.method)
          || !['started', 'succeeded', 'failed'].includes(value.status) || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) throw new TypeError('Invalid activity timing report.');
        activityTiming({ targetId, readId: value.readId, source: value.source, method: value.method, status: value.status, elapsedMs: value.elapsedMs });
      } else if (value.kind === 'state') {
        if (typeof value.applicable !== 'boolean' || !Array.isArray(value.errors)) throw new Error('Invalid Windows renderer report.');
        const previous = registry.windows.get(targetId);
        const activity = value.taskKey?.startsWith('local:') ? sleep.activity.get(value.taskKey.slice(6)) : null;
        registry.update(targetId, { applicable: value.applicable, taskKey: value.taskKey, title: value.title, status: activity ? activity.active ? 'active' : 'idle' : value.status, color: value.color,
          focused: value.focused, unread: value.focused || previous?.taskKey !== value.taskKey ? false : previous?.unread || false });
        errors.delete('target:' + targetId);
        for (const id of errors.keys()) if (id.startsWith('renderer:' + targetId + ':')) errors.delete(id);
        for (const error of value.errors) errors.set('renderer:' + targetId + ':' + error.source, { ...error, id: error.source, targetId });
        if (value.applicable && value.focused) void capture(targetId).catch(error => failed('mapping:' + targetId, error, targetId));
        await publish();
        if (value.applicable && awake && !awakeTimer) { refreshAwake(); awakeTimer = setInterval(refreshAwake, 30000); awakeTimer.unref(); }
      } else if (value.kind === 'activate') {
        try { await activate(value.targetId); } catch (error) { failed('activate', error); }
      } else if (value.kind === 'sleep-toggle') {
        if (typeof value.enabled !== 'boolean') throw new TypeError('Invalid sleep toggle.');
        try { await sleep.setEnabled(value.enabled); errors.delete('auto-sleep'); await publish(); } catch (error) { await sleep.fail(error); }
      } else if (value.kind === 'read-aloud') {
        try { const result = await (services.launchReadAloud || launchReadAloud)(value.path, value.cwd, powershellPath); errors.delete('read-aloud'); await context.log({ event: 'read-aloud-started', targetId, ...result }); await publish(); }
        catch (error) { failed('read-aloud', error); }
      } else if (value.kind === 'restart-protection') {
        let result, error;
        try { if (!protection) throw new Error('Windows 更新参数保护尚未连接。'); result = await protection.protect(); }
        catch (failure) { error = { name: failure.name, message: failure.message, stack: failure.stack, code: failure.code, cause: failure.cause }; }
        await evaluate(session.sessionId, 'window[' + JSON.stringify(stateKey) + ']?.resolveRestart(' + [JSON.stringify(value.requestId), JSON.stringify(result ?? null), JSON.stringify(error ?? null)].join(',') + ')');
        await publish();
      } else if (value.kind === 'activity') {
        if (value.hostId !== 'local') return;
        await sleep.observe(value.method, value.params);
        if (awake) void awake.observe(value.method, value.params).catch(() => { /* AwakeBridge reports its own health. */ });
        for (const listener of activityListeners) listener(value.method, value.params);
        const threadId = value.params.threadId || value.params.thread?.id, taskKey = 'local:' + threadId;
        for (const row of registry.rows()) if (row.taskKey === taskKey) {
          const status = value.params.status?.type || value.params.thread?.status?.type || (value.method === 'turn/started' ? 'active' : value.method === 'turn/completed' ? 'idle' : null);
          const activity = sleep.activity.get(threadId);
          if (status) row.status = activity ? activity.active ? 'active' : 'idle' : status;
          if (value.method === 'turn/completed' && !row.focused) row.unread = true;
        }
        await publish();
      } else throw new Error('Unknown Windows renderer request: ' + value.kind);
    };
    const connect = () => {
      if (connecting) return connecting;
      if (client && !client.closed && worker?.powerReady && !worker.closed) return Promise.all(client.targets().map(attach));
      connecting = (async () => {
        if (client && !client.closed) { client.handlers.delete(receive); await client.close(); }
        client = await context.cdp.acquire({ signal: lifetime.signal });
        const processId = (await client.send('SystemInfo.getProcessInfo')).processInfo.find(value => value.type === 'browser')?.id;
        registry = new WindowRegistry(processId); sessions.clear();
        for (const [id,error] of errors) if (error.targetId) errors.delete(id);
        protection = (services.createRestartProtection || createRestartProtection)({ processId, port: context.cdp.port, powershellPath, signal: lifetime.signal, log: context.log });
        await worker?.close(); worker = services.createWorker ? services.createWorker(powershellPath) : new NativeWindowWorker(powershellPath);
        await worker.open();
        await worker.subscribePower(value => sleep.powerChanged(value), error => { void sleep.fail(error).catch(error => failed('power', error)); });
        errors.delete('cdp'); errors.delete('power'); uiSignature = null;
        client.onError = error => { if (!reportedErrors.has(error)) failed('cdp', error); }; client.handlers.add(receive);
        await Promise.all(client.targets().map(attach)); await publish();
      })().catch(error => { if (!stopped) failed('cdp', error); throw error; }).finally(() => { connecting = null; }); return connecting;
    };
    const page = await fs.readFile(new URL('../assets/windows-manager.html', import.meta.url), 'utf8');
    const unsubscribeReconnect = context.cdp.onReconnect(async () => {
      try { await connecting; }
      catch (error) { if (!['NATIVE_WORKER_TIMEOUT', 'CDP_DISCONNECTED', 'CDP_COMMAND_TIMEOUT'].includes(error.code)) throw error; }
      if (!stopped) return connect();
    });
    const unsubscribe = context.onHostState(value => { hostState = value; void publish().catch(error => failed('delivery', error)); });
    void connect().catch(() => { /* connect reports the original failure. */ });
    const check = async (recovering = false) => {
      await connect(); await worker.powerStatus();
      if (!client.closed) errors.delete('cdp'); errors.delete('power');
      await Promise.all([...sessions].filter(([id]) => !recovering || [...errors.values()].some(error => error.targetId === id)).map(async ([targetId, session]) => { try { await install(targetId, session); await evaluate(session.sessionId, 'window[' + JSON.stringify(stateKey) + ']?.refresh()'); } catch (error) { failed('target:' + targetId, error, targetId); } }));
      uiSignature = null; await publish(); return snapshot();
    };
    return {
      check, recover: () => check(true),
      protectRestart() { if (!protection) throw new Error('Windows 更新参数保护尚未连接。'); return protection.protect(); },
      featureState: () => ({ windows: registry?.rows() || [], autoSleep: sleep.status() }),
      onFeatureState(listener) { const callback = () => listener({ windows: registry?.rows() || [], autoSleep: sleep.status() }); listeners.add(callback); callback(); return () => listeners.delete(callback); },
      awakeSettings: () => ({ awakeScript, powershellPath, handedOff: externalKits.includes('awake-bridge') }),
      readAwakeActivity: () => readActivity('codex_awake'),
      onFeatureActivity(listener) { activityListeners.add(listener); return () => activityListeners.delete(listener); },
      async dispatchFeatureAction(action) {
        if (action.kind === 'activate') return activate(action.targetId);
        if (action.kind === 'sleep-toggle' && typeof action.enabled === 'boolean') { await sleep.setEnabled(action.enabled); await publish(); return; }
        throw new Error('Unknown legacy footer action: ' + action.kind);
      },
      management: { title: { en: 'Windows integration', 'zh-Hans': 'Windows 窗口集成' }, async request({ method, url }) {
        if (method === 'GET' && url.pathname === '/') return { type: 'text/html; charset=utf-8', body: page };
        if (method === 'GET' && url.pathname === '/api/state') return { body: snapshot() };
        if (method === 'GET' && url.pathname === '/api/events') return { subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); } };
        if (method === 'POST' && url.pathname === '/api/check') return { body: await check() };
        return null;
      } },
      async close() {
        stopped = true; sleep.close(); clearInterval(awakeTimer); lifetime.abort(new Error('Windows plugin stopped.')); unsubscribe(); unsubscribeReconnect();
        await Promise.allSettled([connecting, delivery, awake?.close(), protection?.settled(), ...attaching.values(), ...captures.values(), ...[...sessions.values()].map(value => value.installing)]);
        const failures = [];
        if (client && !client.closed) for (const [id, session] of sessions) {
          try {
            if (session.scriptId) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }, session.sessionId);
            await evaluate(session.sessionId, 'window[' + JSON.stringify(stateKey) + ']?.cleanup()');
            if (session.bound) await client.send('Runtime.removeBinding', { name: bindingName }, session.sessionId);
          } catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') failures.push(new Error('Windows cleanup failed for ' + id, { cause: error })); }
        }
        try { await worker?.close(); } catch (error) { failures.push(error); }
        try { await client?.close(); } catch (error) { failures.push(error); }
        listeners.clear(); activityListeners.clear(); if (failures.length) throw new AggregateError(failures, 'Windows cleanup failed.', { cause: failures[0] });
      },
    };
  } };
}
