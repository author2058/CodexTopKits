import fs from 'node:fs/promises';
import path from 'node:path';
import { CORE_API_VERSION } from 'codex-toolkit-core';
import { initializePage } from 'codex-toolkit-core/cdp';
import { openThemeStore } from './store.mjs';
import { canonicalTaskKey, resolveTheme, ThemeConfigError } from './model.mjs';
import { themePayload } from './payload.mjs';

const bindingName = '__CDTK_THEMES_REPORT__';
const stateKey = '__CODEX_DESKTOP_TOOLKIT_THEMES__';

export default function themesPlugin({ cdpPort = 'auto', mapPath, externalKits = [] } = {}) {
  if (CORE_API_VERSION !== 1) throw new Error('Themes requires Core API 1.');
  if (!Array.isArray(externalKits) || externalKits.some(id => !['ui-font-size', 'project-thread-colors', 'profile-panel-shadow'].includes(id))) throw new TypeError('Invalid external Themes Kit.');
  return { id: 'themes', coreApiVersion: 1, cdpPort, async start(context) {
    if (typeof context.cdp?.onReconnect !== 'function') throw new Error('Themes requires the shared CDP service from Core 0.3.5 or newer.');
    const lifetime = new AbortController(), listeners = new Set(), reports = new Map(), attached = new Map(), attaching = new Map();
    const projects = new Map(), tasks = new Map(), failures = new Map();
    let store, client, connecting, stopped = false, applying = Promise.resolve(), revision = 0, lastState = null;
    const logFailure = (id, error) => {
      if (stopped) return;
      failures.set(id, { id, name: error.name, message: error.message, stack: error.stack });
      void context.log({ event: 'themes-failed', id, name: error.name, message: error.message, stack: error.stack }).catch(error => console.error('Themes diagnostic write failed:', error));
      publish();
    };
    const snapshot = () => {
      const projectRows = new Map(projects), taskRows = new Map(tasks);
      for (const name of Object.keys(store.map.projects)) if (!projectRows.has(name)) projectRows.set(name, { name });
      for (const taskKey of Object.keys(store.map.tasks)) if (!taskRows.has(taskKey)) taskRows.set(taskKey, { taskKey, title: taskKey, projectName: null });
      return { map: store.map, revision, errors: [...failures.values()], windows: [...reports].map(([targetId, report]) => ({ targetId, applicable: report.applicable, context: report.context })),
        catalog: {
          projects: [...projectRows.values()].sort((a, b) => a.name.localeCompare(b.name)).map(project => ({ ...project, ...resolveTheme(store.map, { projectName: project.name }) })),
          tasks: [...taskRows.values()].sort((a, b) => (a.title || a.taskKey).localeCompare(b.title || b.taskKey)).map(task => ({ ...task, ...resolveTheme(store.map, task) })),
        } };
    };
    const publish = () => {
      if (!store || stopped) return;
      const mainCount = [...reports.values()].filter(report => report.applicable).length;
      context.setHealth({ ok: failures.size === 0, issueCount: failures.size, message: failures.size ? [...failures.values()].map(error => error.message).join('; ') : mainCount ? `主题已连接 ${mainCount} 个主窗口。` : '主题服务已就绪，等待 Codex 主窗口。',
        issues: [...failures].map(([key, error]) => ({ key, message: error.message })),
        ...(!failures.size ? { messageLocales: { en: mainCount ? `Themes connected to ${mainCount} main windows.` : 'Themes are ready; waiting for a Codex main window.', 'zh-Hans': mainCount ? `主题已连接 ${mainCount} 个主窗口。` : '主题服务已就绪，等待 Codex 主窗口。' } } : {}) });
      const value = snapshot(), signature = JSON.stringify({ ...value, revision: 0 });
      if (signature === lastState) return;
      lastState = signature; value.revision = ++revision;
      for (const listener of listeners) listener(value);
    };
    const evaluate = async (sessionId, expression) => {
      const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: false }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    const install = (targetId, session) => {
      const work = (session.installing || Promise.resolve()).then(async () => {
        if (stopped) return;
        if (session.scriptId) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }, session.sessionId);
        const source = themePayload(store.map, { externalKits });
        session.scriptId = (await client.send('Page.addScriptToEvaluateOnNewDocument', { source }, session.sessionId)).identifier;
        await evaluate(session.sessionId, source);
        failures.delete('target:' + targetId); publish();
      });
      session.installing = work.catch(() => { /* Each caller retains and reports the original rejection. */ });
      return work;
    };
    const attach = target => {
      if (stopped || target.type !== 'page' || !target.url?.startsWith('app://') || attached.has(target.targetId)) return Promise.resolve();
      if (attaching.has(target.targetId)) return attaching.get(target.targetId);
      const job = (async () => {
        const session = await initializePage(client, target.targetId, bindingName);
        attached.set(target.targetId, session);
        await install(target.targetId, session);
      })().catch(error => { if (error.code !== 'CDP_TARGET_CLOSED') logFailure('target:' + target.targetId, error); }).finally(() => attaching.delete(target.targetId));
      attaching.set(target.targetId, job); return job;
    };
    const receive = async message => {
      const params = message.params || {};
      if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') return attach(params.targetInfo);
      if (message.method === 'Target.targetDestroyed') {
        attached.delete(params.targetId); reports.delete(params.targetId);
        for (const id of failures.keys()) if (id.startsWith('renderer:' + params.targetId + ':') || id === 'target:' + params.targetId) failures.delete(id);
        publish(); return;
      }
      if (message.method === 'Target.detachedFromTarget') {
        const entry = [...attached].find(([, session]) => session.sessionId === params.sessionId);
        if (entry) { attached.delete(entry[0]); reports.delete(entry[0]); publish(); }
        return;
      }
      const entry = [...attached].find(([, session]) => session.sessionId === message.sessionId);
      if (!entry) return;
      const [targetId, session] = entry;
      if (message.method === 'Runtime.bindingCalled' && params.name === bindingName) {
        const report = JSON.parse(params.payload);
        if (typeof report.applicable !== 'boolean' || !report.catalog || !Array.isArray(report.catalog.projects) || !Array.isArray(report.catalog.tasks) || !Array.isArray(report.errors)) throw new Error('Invalid Themes renderer report.');
        reports.set(targetId, report); failures.delete('target:' + targetId);
        for (const id of failures.keys()) if (id.startsWith('renderer:' + targetId + ':')) failures.delete(id);
        for (const error of report.errors) failures.set('renderer:' + targetId + ':' + error.source, { ...error, id: error.source, targetId });
        for (const project of report.catalog.projects) projects.set(project.name, { ...project, targetId });
        for (const task of report.catalog.tasks) {
          const taskKey = canonicalTaskKey(task.taskKey), previous = tasks.get(taskKey);
          if (taskKey) tasks.set(taskKey, { ...previous, ...task, taskKey, targetId, projectName: task.projectName || (taskKey !== report.context?.taskKey ? previous?.projectName : null) || null });
        }
        publish();
      } else if (message.method === 'Page.frameNavigated' && !params.frame.parentId) await install(targetId, session);
    };
    const connect = () => {
      if (connecting) return connecting;
      if (client && !client.closed) return Promise.all(client.targets().map(attach));
      connecting = (async () => {
        client = await context.cdp.acquire({ signal: lifetime.signal });
        failures.delete('cdp'); attached.clear(); reports.clear();
        for (const id of failures.keys()) if (id.startsWith('target:') || id.startsWith('renderer:')) failures.delete(id);
        client.onError = error => logFailure('cdp', error);
        client.handlers.add(receive);
        await Promise.all(client.targets().map(attach));
      })().catch(error => { if (!stopped) logFailure('cdp', error); throw error; }).finally(() => { connecting = null; });
      return connecting;
    };
    const applyMap = () => {
      failures.delete('map'); publish();
      applying = applying.then(async () => {
        if (stopped || !client || client.closed) return;
        await Promise.all([...attached].map(async ([targetId, session]) => {
          try { await install(targetId, session); } catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') logFailure('target:' + targetId, error); }
        }));
      }).catch(error => logFailure('apply', error));
    };
    const unsubscribeReconnect = context.cdp.onReconnect(async () => {
      await connecting;
      if (!stopped) return connect();
    });
    try {
      const initial = JSON.parse(await fs.readFile(new URL('../assets/theme-map.json', import.meta.url), 'utf8'));
      store = await openThemeStore({ filename: mapPath ?? path.join(context.stateDirectory, 'theme-map.json'), defaultMap: initial, changed: applyMap, failed: error => logFailure('map', error) });
      await fs.readFile(new URL('../assets/theme-manager.html', import.meta.url), 'utf8');
      publish(); void connect().catch(() => { /* connect reports the original failure in health and logs. */ });
      const check = async (recovering = false) => {
        await connect();
        if (recovering && failures.has('cdp')) await client.send('Browser.getVersion');
        await Promise.all([...attached].filter(([id]) => !recovering || [...failures.keys()].some(key => key === 'target:' + id || key.startsWith('renderer:' + id + ':'))).map(async ([targetId, session]) => {
          try {
            await install(targetId, session);
            await evaluate(session.sessionId, `window[${JSON.stringify(stateKey)}]?.refresh()`);
          } catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') logFailure('target:' + targetId, error); }
        }));
        if (!client.closed) failures.delete('cdp'); publish(); return snapshot();
      };
      return {
        check, recover: () => check(true),
        featureState: () => ({ themeSettings: { uiFontSizeOverride: store.map.uiFontSizeOverride, map: store.map } }),
        onFeatureState(listener) {
          const forward = value => listener({ themeSettings: { uiFontSizeOverride: value.map.uiFontSizeOverride, map: value.map } });
          listeners.add(forward); return () => listeners.delete(forward);
        },
        management: { title: { en: 'Themes', 'zh-Hans': '主题设置' }, async request({ method, url, body }) {
          if (method === 'GET' && url.pathname === '/') return { type: 'text/html; charset=utf-8', body: await fs.readFile(new URL('../assets/theme-manager.html', import.meta.url), 'utf8') };
          if (method === 'GET' && url.pathname === '/api/state') return { body: snapshot() };
          if (method === 'GET' && url.pathname === '/api/events') return { subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); } };
          if (method !== 'POST') return null;
          try {
            if (url.pathname === '/api/assignment') { await store.assign(body); return { body: snapshot() }; }
            if (url.pathname === '/api/appearance') { await store.appearance(body); return { body: snapshot() }; }
            if (url.pathname === '/api/check') return { body: await check() };
          } catch (error) { if (error instanceof ThemeConfigError) error.status = 400; throw error; }
          return null;
        } },
        async close() {
          stopped = true; unsubscribeReconnect(); lifetime.abort(new Error('Themes plugin stopped.'));
          await store.close(); await Promise.allSettled([connecting, applying, ...attaching.values()]);
          const errors = [];
          if (client && !client.closed) for (const [targetId, session] of attached) {
            try {
              await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }, session.sessionId);
              await evaluate(session.sessionId, `window[${JSON.stringify(stateKey)}]?.cleanup()`);
              await client.send('Runtime.removeBinding', { name: bindingName }, session.sessionId);
            } catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') errors.push(new Error('Themes cleanup failed for ' + targetId, { cause: error })); }
          }
          try { await client?.close(); } catch (error) { errors.push(error); }
          listeners.clear();
          if (errors.length) throw new AggregateError(errors, 'Themes cleanup failed.', { cause: errors[0] });
        },
      };
    } catch (error) {
      stopped = true; unsubscribeReconnect(); lifetime.abort(error);
      try { await store?.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Themes startup and cleanup failed.', { cause: error }); }
      throw error;
    }
  } };
}
