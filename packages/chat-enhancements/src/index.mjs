import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CORE_API_VERSION } from 'codex-toolkit-core';
import { initializePage } from 'codex-toolkit-core/cdp';
import { chatPayload } from './payload.mjs';
import { readMessageLabelIndex } from './message-label-history.mjs';
import { HardResetFeed, powerShellHardResetFetch } from './hard-reset.mjs';

const stateKey = '__CODEX_DESKTOP_TOOLKIT_CHAT__', bindingName = '__CDTK_CHAT_BRIDGE__';

export default function chatPlugin({ cdpPort = 'auto', codexHome, powershellPath = 'pwsh.exe', scrollHandoffEnabled = false, scrollDiagnosticsEnabled = false, externalWeeklyUsage = false, externalKits = [] } = {}, services = {}) {
  if (CORE_API_VERSION !== 1) throw new Error('Chat Enhancements requires Core API 1.');
  if (codexHome !== undefined && !path.isAbsolute(codexHome)) throw new Error('codexHome must be an absolute path.');
  if (typeof scrollHandoffEnabled !== 'boolean' || typeof scrollDiagnosticsEnabled !== 'boolean') throw new TypeError('Scroll options must be boolean.');
  if (typeof externalWeeklyUsage !== 'boolean') throw new TypeError('externalWeeklyUsage must be boolean.');
  if (!Array.isArray(externalKits) || externalKits.some(id => !['table-style', 'image-viewer-close', 'selection-actions-delay', 'file-line-highlight', 'rich-paste-boundary', 'context-meter', 'output-speed', 'composer-timer', 'live-model-output', 'message-labels', 'history-show-all', 'title-emoji', 'fast-mode-indicator', 'child-model-warning', 'scroll-handoff-fix', 'scroll-diagnostics'].includes(id))) throw new TypeError('Invalid external Chat Kit.');
  return { id: 'chat', coreApiVersion: 1, cdpPort, async start(context) {
    if (typeof context.cdp?.onReconnect !== 'function' || typeof context.onHostState !== 'function') throw new Error('Chat Enhancements requires Core 0.3.5 or newer.');
    const lifetime = new AbortController(), runId = randomUUID(), sessions = new Map(), attaching = new Map(), reports = new Map(), errors = new Map(), listeners = new Set();
    let client, connecting, stopped = false, generation = 0, hostState = null, usage = null, lastState = null, revision = 0, forecastTimer = null, forecastWork = null, forecastStarted = false, forecastEnabled = !externalWeeklyUsage;
      const feed = new HardResetFeed({ cachePath: context.stateDirectory ? path.join(context.stateDirectory, 'hard-reset.json') : null,
      fetchImpl: services.hardResetFetch || (process.platform === 'win32' ? powerShellHardResetFetch(promisify(execFile), powershellPath, fileURLToPath(new URL('./fetch-hard-reset-status.ps1', import.meta.url))) : fetch) });
    const snapshot = () => ({ revision, usage, hardReset: feed.snapshot(), hostState, windows: [...reports].map(([targetId, report]) => ({ targetId, ...report })), errors: [...errors.values()] });
    const publish = () => {
      if (stopped) return;
      const mainCount = [...reports.values()].filter(value => value.applicable).length;
      context.setHealth({ ok: errors.size === 0, issueCount: errors.size, message: errors.size ? [...errors.values()].map(error => error.message).join('; ') : mainCount ? '聊天增强已连接 ' + mainCount + ' 个主窗口。' : '聊天增强已就绪，等待 Codex 主窗口。',
        issues: [...errors].map(([key, error]) => ({ key, message: error.message })),
        ...(!errors.size ? { messageLocales: { en: mainCount ? `Chat enhancements connected to ${mainCount} main windows.` : 'Chat enhancements are ready; waiting for a Codex main window.', 'zh-Hans': mainCount ? '聊天增强已连接 ' + mainCount + ' 个主窗口。' : '聊天增强已就绪，等待 Codex 主窗口。' } } : {}) });
      const value = snapshot(), signature = JSON.stringify({ ...value, revision: 0 });
      if (lastState === signature) return;
      lastState = signature; value.revision = ++revision;
      for (const listener of listeners) listener(value);
    };
    const failed = (id, error, targetId) => {
      if (stopped || error.code === 'CDP_TARGET_CLOSED') return;
      errors.set(id, { id, targetId, name: error.name, message: error.message, stack: error.stack });
      void context.log({ event: 'chat-failed', id, targetId, name: error.name, message: error.message, stack: error.stack }).catch(error => console.error('Chat diagnostic write failed:', error)); publish();
    };
    const evaluate = async (sessionId, expression) => {
      const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    const broadcast = (method, value, targetId) => {
      if (!client || client.closed || stopped) return Promise.resolve();
      return Promise.all([...sessions].filter(([id]) => !targetId || id === targetId).map(([id, session]) => {
        const key = 'delivery:' + id + ':' + method;
        return evaluate(session.sessionId, 'window[' + JSON.stringify(stateKey) + ']?.' + method + '(' + JSON.stringify(value) + ')').then(result => {
          if (sessions.get(id) === session && result === true && errors.delete(key)) publish();
        }).catch(error => failed(key, error, id));
      }));
    };
    const install = (id, session) => {
      const work = (session.installing || Promise.resolve()).then(async () => {
        if (stopped) return;
        if (session.scriptId) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }, session.sessionId);
        const source = chatPayload({ epoch: runId + ':' + generation, hostState, usage, hardReset: feed.snapshot(), scrollHandoffEnabled, scrollDiagnosticsEnabled, externalWeeklyUsage, externalKits });
        session.scriptId = (await client.send('Page.addScriptToEvaluateOnNewDocument', { source }, session.sessionId)).identifier;
        await evaluate(session.sessionId, source); errors.delete('target:' + id); publish();
      });
      session.installing = work.catch(() => { /* Each caller reports its original rejection. */ }); return work;
    };
    const attach = target => {
      if (stopped || target.type !== 'page' || !target.url.startsWith('app://') || sessions.has(target.targetId)) return Promise.resolve();
      if (attaching.has(target.targetId)) return attaching.get(target.targetId);
      const work = (async () => {
        const session = await initializePage(client, target.targetId, bindingName); sessions.set(target.targetId, session);
        await install(target.targetId, session);
      })().catch(error => failed('target:' + target.targetId, error, target.targetId)).finally(() => attaching.delete(target.targetId));
      attaching.set(target.targetId, work); return work;
    };
    const remove = targetId => {
      sessions.delete(targetId); reports.delete(targetId);
      for (const [id, error] of errors) if (error.targetId === targetId) errors.delete(id);
      publish();
    };
    const receive = async message => {
      const params = message.params || {};
      if (['Target.targetCreated', 'Target.targetInfoChanged'].includes(message.method)) return attach(params.targetInfo);
      if (message.method === 'Target.targetDestroyed') return remove(params.targetId);
      if (message.method === 'Target.detachedFromTarget') { const row = [...sessions].find(([, value]) => value.sessionId === params.sessionId); if (row) remove(row[0]); return; }
      const row = [...sessions].find(([, value]) => value.sessionId === message.sessionId); if (!row) return;
      const [id, session] = row;
      if (message.method === 'Page.frameNavigated' && !params.frame.parentId) return install(id, session);
      if (message.method !== 'Runtime.bindingCalled' || params.name !== bindingName) return;
      const value = JSON.parse(params.payload);
      if (value.kind === 'state') {
        if (typeof value.applicable !== 'boolean' || !Array.isArray(value.errors)) throw new Error('Invalid Chat renderer state.');
        reports.set(id, value); errors.delete('target:' + id);
        for (const key of errors.keys()) if (key.startsWith('renderer:' + id + ':')) errors.delete(key);
        for (const error of value.errors) errors.set('renderer:' + id + ':' + error.source, { id: error.source, targetId: id, ...error }); publish();
        if (value.applicable && !forecastStarted && forecastEnabled) { forecastStarted = true; void refreshForecast(); }
      } else if (value.kind === 'usage') {
        if (!value.snapshot?.weekly || !Number.isFinite(value.snapshot.updatedAt)) throw new Error('Invalid native usage snapshot.');
        if ((!usage || value.snapshot.updatedAt >= usage.updatedAt) && JSON.stringify(value.snapshot) !== JSON.stringify(usage)) { usage = value.snapshot; broadcast('setUsage', usage); publish(); }
      } else if (value.kind === 'history-index') {
        let result, error;
        try { result = await readMessageLabelIndex(value, codexHome ? { dbPath: path.join(codexHome, 'thread_history_1.sqlite') } : {}); }
        catch (failure) { error = { name: failure.name, message: failure.message, stack: failure.stack }; }
        await evaluate(session.sessionId, 'window[' + JSON.stringify(stateKey) + ']?.resolveHistoryIndex(' + [JSON.stringify(value.requestId), JSON.stringify(result ?? null), JSON.stringify(error ?? null)].join(',') + ')');
      } else if (value.kind === 'diagnostic') {
        await context.log({ event: 'chat-diagnostic', targetId: id, feature: value.feature, record: value.record });
      } else throw new Error('Unknown Chat renderer request: ' + value.kind);
    };
    const connect = () => {
      if (connecting) return connecting;
      if (client && !client.closed) return Promise.all(client.targets().map(attach));
      connecting = (async () => {
        client = await context.cdp.acquire({ signal: lifetime.signal }); generation++; sessions.clear(); reports.clear(); errors.delete('cdp');
        for (const [id,error] of errors) if (error.targetId) errors.delete(id);
        client.onError = error => failed('cdp', error); client.handlers.add(receive);
        await Promise.all(client.targets().map(attach)); publish();
      })().catch(error => { if (!stopped) failed('cdp', error); throw error; }).finally(() => { connecting = null; }); return connecting;
    };
    const page = await fs.readFile(new URL('../assets/chat-manager.html', import.meta.url), 'utf8');
    const unsubscribeReconnect = context.cdp.onReconnect(async () => {
      await connecting;
      if (!stopped) return connect();
    });
    const unsubscribe = context.onHostState(value => { hostState = value; broadcast('setHostState', value); });
    const refreshForecast = (retry = false) => {
      if (forecastWork) return forecastWork;
      clearTimeout(forecastTimer); forecastTimer = null;
      forecastWork = (async () => {
        try { if (await (retry ? feed.retry() : feed.refresh()) === true) errors.delete('hard-reset'); }
        catch (error) { if (!stopped) failed('hard-reset', error); }
        if (stopped || !forecastEnabled) return;
        await broadcast('setHardReset', feed.snapshot()); publish();
        if (!feed.halted) { forecastTimer = setTimeout(() => { forecastTimer = null; void refreshForecast(); }, Math.max(0, feed.nextCheckAt - Date.now())); forecastTimer.unref(); }
      })().finally(() => { forecastWork = null; });
      return forecastWork;
    };
    publish(); void connect().catch(() => { /* connect preserves the failure in health and logs. */ });
    const check = async (recovering = false) => {
      if (!recovering) generation++;
      await connect();
      if (recovering && errors.has('cdp')) await client.send('Browser.getVersion');
      await Promise.all([...sessions].filter(([id]) => !recovering || [...errors.values()].some(error => error.targetId === id && !error.id.startsWith('delivery:'))).map(async ([id, session]) => {
        try { await install(id, session); await evaluate(session.sessionId, 'window[' + JSON.stringify(stateKey) + ']?.' + (recovering ? 'recover' : 'refresh') + '()'); }
        catch (error) { failed('target:' + id, error, id); }
      }));
      if (!client.closed) errors.delete('cdp');
      const states = { setHostState: hostState, setUsage: usage, setHardReset: feed.snapshot() };
      await Promise.all([...sessions.keys()].flatMap(id => Object.entries(states).filter(([method]) => errors.has('delivery:' + id + ':' + method)).map(([method, value]) => broadcast(method, value, id))));
      if (recovering && errors.has('hard-reset')) await refreshForecast(true);
      publish(); return snapshot();
    };
    return {
      check, recover: () => check(true),
      featureState: () => ({ hardReset: feed.snapshot() }),
      onFeatureState(listener) { const callback = () => listener({ hardReset: feed.snapshot() }); listeners.add(callback); callback(); return () => listeners.delete(callback); },
      startFeatureForecast() { if (externalWeeklyUsage && !forecastEnabled) { forecastEnabled = forecastStarted = true; void refreshForecast(); } },
      stopFeatureForecast() { if (externalWeeklyUsage) { forecastEnabled = forecastStarted = false; clearTimeout(forecastTimer); forecastTimer = null; } },
      management: { title: { en: 'Chat Enhancements', 'zh-Hans': '聊天增强' }, async request({ method, url }) {
        if (method === 'GET' && url.pathname === '/') return { type: 'text/html; charset=utf-8', body: page };
        if (method === 'GET' && url.pathname === '/api/state') return { body: snapshot() };
        if (method === 'GET' && url.pathname === '/api/events') return { subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); } };
        if (method === 'POST' && url.pathname === '/api/check') return { body: await check() };
        return null;
      } },
      async close() {
          stopped = true; clearTimeout(forecastTimer); feed.close(); lifetime.abort(new Error('Chat plugin stopped.')); unsubscribe(); unsubscribeReconnect(); await Promise.allSettled([connecting, forecastWork, feed.pending, ...attaching.values(), ...[...sessions.values()].map(value => value.installing)]);
        const failures = [];
        if (client && !client.closed) for (const [id, session] of sessions) {
          try {
            if (session.scriptId) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }, session.sessionId);
            await evaluate(session.sessionId, 'window[' + JSON.stringify(stateKey) + ']?.cleanup()');
            if (session.bound) await client.send('Runtime.removeBinding', { name: bindingName }, session.sessionId);
          } catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') failures.push(new Error('Chat cleanup failed for ' + id, { cause: error })); }
        }
        try { await client?.close(); } catch (error) { failures.push(error); }
        listeners.clear(); if (failures.length) throw new AggregateError(failures, 'Chat cleanup failed.', { cause: failures[0] });
      },
    };
  } };
}
