export function installThemeRenderer(window, initialMap, helpers, options = {}) {
  const key = options.key || '__CODEX_DESKTOP_TOOLKIT_THEMES__', binding = options.binding || '__CDTK_THEMES_REPORT__', styleId = options.styleId || 'cdtk-themes-style';
  const { canonicalTaskKey, projectNameForThread, resolveTheme, themeCss, themeChannelColor, createNativeAssetReader, loadNativeAppServices, createNativeBridgeClient, readNativeConversationIdentity } = helpers;
  const document = window.document;
  if (window !== window.top) return { applicable: false };
  if (window.__CODEX_DYNAMIC_THEME__) throw new Error('旧主题控制器仍在此页面运行；请先停止旧注入，再启用 Themes。');
  if (window[key]) return window[key].update(initialMap);
  if (document.readyState === 'loading') {
    let latest = initialMap;
    const status = { applicable: false, pending: true };
    const start = () => {
      if (window[key] !== pending) return;
      delete window[key];
      try { installThemeRenderer(window, latest, helpers, options); }
      catch (error) {
        if (typeof window[binding] !== 'function') throw error;
        window[binding](JSON.stringify({ applicable: false, context: {}, catalog: { projects: [], tasks: [] }, errors: [{ source: 'startup', name: error.name, message: error.message, stack: error.stack }] }));
      }
    };
    const pending = window[key] = {
      update(next) { latest = next; return status; },
      refresh() { return status; },
      cleanup() { document.removeEventListener('DOMContentLoaded', start); delete window[key]; },
    };
    document.addEventListener('DOMContentLoaded', start, { once: true });
    return status;
  }
  const channels = ['accent', 'canvas', 'surface', 'sidebar'];
  const externalFont = options.externalKits?.includes('ui-font-size');
  const externalColors = options.externalKits?.includes('project-thread-colors');
  const ownClasses = [...(externalColors ? [] : channels.map(value => 'cdtk-theme-' + value)), ...(externalFont ? [] : ['cdtk-ui-font-override'])];
  let map = initialMap, stopped = false, scheduled = false, loaded = false, loading = null, threadLoading = null, servicesPromise;
  let hydrateAgain = false, catalogAgain = false;
  let projects = {}, assignments = {}, upstream = null, signature = null, lastContext = null, contextSignature = null;
  const contextListeners = new Set();
  const errors = new Map();
  let assets = createNativeAssetReader(document);
  const bridge = createNativeBridgeClient(window), request = bridge.request;
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null;
  const visible = element => element && element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== 'hidden';
  const detached = window.location.pathname === '/detached-window.html';
  const applicable = () => !detached && [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
  const identity = () => readNativeConversationIdentity(document)?.taskKey || null;
  const services = () => servicesPromise ||= loadNativeAppServices(document, { assets }).catch(failure => { servicesPromise = null; throw failure; });
  const readGlobal = async name => {
    const native = await services();
    if (name === 'local-projects' && native.projectCatalog) {
      if (typeof native.projectCatalog.readLocalProjects !== 'function') throw new Error('工程目录接口已变化。');
      return native.projectCatalog.readLocalProjects();
    }
    if (name === 'thread-project-assignments' && native.threadProjectAssignments) {
      if (typeof native.threadProjectAssignments.readMemberships !== 'function') throw new Error('工程归属接口已变化。');
      return (await native.threadProjectAssignments.readMemberships()).assignments;
    }
    const id = 'cdtk-theme-global-' + window.crypto.randomUUID();
    const response = await request({ type: 'fetch', requestId: id, url: 'vscode://codex/get-global-state', method: 'POST', body: JSON.stringify({ key: name }) }, 'fetch-response', id);
    if (response.status < 200 || response.status >= 300) throw new Error('读取 ' + name + ' 返回 HTTP ' + response.status + '。');
    return JSON.parse(response.bodyJsonString).value;
  };
  const bootstrap = () => window.electronBridge?.getInitialSidebarBootstrap?.() || {};
  const seedGlobal = name => bootstrap().globalStateEntries?.find(entry => entry.key === name)?.value;
  projects = seedGlobal('local-projects') || {}; assignments = seedGlobal('thread-project-assignments') || {};
  const catalog = context => {
    const entries = new Map((bootstrap().catalogEntries || []).map(entry => [entry.threadId, entry]));
    const tasks = new Map();
    for (const entry of entries.values()) {
      const taskKey = canonicalTaskKey(entry.threadId, entry.hostId || 'local');
      if (taskKey) tasks.set(taskKey, { taskKey, title: clean(entry.displayTitle) || entry.threadId, projectName: projectNameForThread(taskKey, assignments, projects, entry.cwd) });
    }
    for (const element of document.querySelectorAll('[data-app-action-sidebar-thread-id]')) {
      const taskKey = canonicalTaskKey(element.getAttribute('data-app-action-sidebar-thread-id'));
      if (!taskKey) continue;
      const seed = entries.get(taskKey.split(':').at(-1));
      tasks.set(taskKey, { taskKey, title: clean(element.getAttribute('data-app-action-sidebar-thread-title') || element.getAttribute('aria-label') || element.textContent),
        projectName: projectNameForThread(taskKey, assignments, projects, seed?.cwd) });
    }
    if (context.taskKey) tasks.set(context.taskKey, { taskKey: context.taskKey, title: context.taskTitle, projectName: context.projectName });
    return { projects: (Array.isArray(projects) ? projects : Object.values(projects)).filter(project => typeof project?.name === 'string').map(project => ({ name: project.name, rootPaths: project.rootPaths || [] })), tasks: [...tasks.values()] };
  };
  const report = context => {
    const value = { applicable: applicable(), context, catalog: catalog(context), errors: [...errors].map(([source, error]) => ({ source, name: error.name, message: error.message, stack: error.stack })) };
    const text = JSON.stringify(value);
    if (text !== signature && !stopped) {
      const send = window[binding];
      if (typeof send !== 'function') throw new Error('Themes 状态回报接口不可用。');
      send(text); signature = text;
    }
    return value;
  };
  const toggle = (name, value) => { if (document.documentElement.classList.contains(name) !== value) document.documentElement.classList.toggle(name, value); };
  const paint = () => {
    if (stopped) return;
    const isMain = applicable(), taskKey = isMain ? identity() : null;
    const mainEvidence = !detached && document.querySelector('[data-above-composer-conversation-id]:not([role="tabpanel"] *):not([data-app-shell-tab-panel-controller="right"] *)');
    if (!isMain && mainEvidence) errors.set('main-surface', new Error('已发现主会话，但内容区域入口已变化，主题未应用。'));
    else errors.delete('main-surface');
    const active = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')].find(element => canonicalTaskKey(element.getAttribute('data-app-action-sidebar-thread-id')) === taskKey);
    const selected = upstream?.taskKey === taskKey ? upstream : null;
    const projectControl = [...document.querySelectorAll('header button[aria-label^="Project: "]')].find(visible);
    const seed = bootstrap().catalogEntries?.find(entry => entry.threadId === taskKey?.split(':').at(-1));
    const projectName = selected?.projectName || projectControl?.getAttribute('aria-label')?.slice(9) || projectNameForThread(taskKey, assignments, projects, seed?.cwd) || null;
    const taskTitle = selected?.taskTitle || clean(active?.getAttribute('data-app-action-sidebar-thread-title') || active?.getAttribute('aria-label') || active?.textContent);
    const context = { taskKey, taskTitle, projectName, ...resolveTheme(map, { taskKey, projectName }), source: selected ? 'app-server' : 'bootstrap-or-project-control' };
    if (!externalColors) for (const channel of channels) {
      const enabled = Boolean(isMain && context.theme && map.enabledColors[channel]);
      toggle('cdtk-theme-' + channel, enabled);
      const variable = '--cdtk-' + channel, value = enabled ? themeChannelColor(channel, context.theme[channel], context.theme.accent) : '';
      if (document.documentElement.style.getPropertyValue(variable) !== value) value ? document.documentElement.style.setProperty(variable, value) : document.documentElement.style.removeProperty(variable);
    }
    if (!externalFont) toggle('cdtk-ui-font-override', isMain && Number.isInteger(map.uiFontSizeOverride));
    if (isMain) {
      let style = document.getElementById(styleId);
      if (!style) { style = document.createElement('style'); style.id = styleId; document.head.appendChild(style); }
      const css = themeCss(externalFont ? { ...map, uiFontSizeOverride: null } : map, { colors: !externalColors, profileShadow: options.profileShadow !== false }); if (style.textContent !== css) style.textContent = css;
    }
    lastContext = { taskKey, projectName, applicable: isMain };
    const nextContext = JSON.stringify(lastContext);
    if (nextContext !== contextSignature) { contextSignature = nextContext; for (const listener of contextListeners) listener(lastContext); }
    return report(context);
  };
  const failed = failure => { if (!stopped) { if (![...errors.values()].includes(failure)) errors.set('renderer', failure); paint(); } };
  const hydrate = async force => {
    const taskKey = identity();
    if (!taskKey) { upstream = null; errors.delete('thread'); return; }
    if (threadLoading) { if (force) hydrateAgain = true; return; }
    if (!force && upstream?.taskKey === taskKey) return;
    const id = 'cdtk-theme-thread-' + window.crypto.randomUUID();
    threadLoading = request({ type: 'mcp-request', hostId: taskKey.slice(0, taskKey.lastIndexOf(':')), request: { id, method: 'thread/read', params: { threadId: taskKey.split(':').at(-1), includeTurns: false } }, priority: 'background', source: 'thread_hydration', timeoutMs: 5000 }, 'mcp-response', id);
    try {
      const response = await threadLoading;
      if (response.message?.error) throw Object.assign(new Error(response.message.error.message), response.message.error);
      const thread = response.message?.result?.thread;
      if (!thread) throw new Error('thread/read 没有返回会话。');
      if (stopped || identity() !== taskKey) return;
      upstream = { taskKey, taskTitle: clean(thread.name || thread.title), projectName: projectNameForThread(taskKey, assignments, projects, thread.cwd || thread.environments?.find(entry => entry.environmentId === 'local')?.cwd, thread.projectId) };
      errors.delete('thread'); paint();
    } catch (failure) { if (!stopped && identity() === taskKey) { errors.set('thread', failure); throw failure; }
    } finally {
      threadLoading = null;
      const again = hydrateAgain; hydrateAgain = false;
      if (!stopped && identity() && (again || identity() !== taskKey)) void hydrate(again).catch(failed);
    }
  };
  const refresh = async (force = false) => {
    const value = paint();
    if (!applicable()) return value;
    if (!loaded || force) {
      if (loading && force) catalogAgain = true;
      if (!loading) loading = Promise.all([readGlobal('local-projects'), readGlobal('thread-project-assignments')]).then(([nextProjects, nextAssignments]) => {
        if (!nextProjects || typeof nextProjects !== 'object' || !nextAssignments || typeof nextAssignments !== 'object') throw new Error('工程目录或会话归属数据格式已变化。');
        projects = nextProjects; assignments = nextAssignments; loaded = true; errors.delete('catalog');
      }).catch(failure => { errors.set('catalog', failure); throw failure; }).finally(() => { loading = null; });
      await loading;
      if (catalogAgain) { catalogAgain = false; return refresh(true); }
    }
    await hydrate(force); errors.delete('renderer'); return paint();
  };
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true; window.queueMicrotask(() => { scheduled = false; if (!stopped) void refresh().catch(failed); });
  };
  const watchedSelector = 'main,[class*="_Workspace_"],[data-codex-composer-root],[data-above-composer-conversation-id],[data-app-action-sidebar-thread-id],header button[aria-label^="Project: "]';
  const observer = new window.MutationObserver(records => {
    const relevant = records.some(record => {
      if (record.target?.id === styleId || record.target?.parentElement?.id === styleId) return false;
      if (record.type === 'attributes') return record.target.matches?.(watchedSelector) || false;
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches?.(watchedSelector) || node.querySelector?.(watchedSelector)));
    });
    if (relevant) schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-above-composer-conversation-id', 'data-app-action-sidebar-thread-active', 'aria-current', 'aria-label', 'class', 'style'] });
  const onMessage = event => {
    if (event.source && event.source !== window) return;
    const data = event.data, notification = data?.notification || data;
    if (data?.type === 'global-state-updated' && data.keys?.some(name => ['local-projects', 'thread-project-assignments'].includes(name))) void refresh(true).catch(failed);
    const taskKey = identity(), hostId = taskKey?.slice(0, taskKey.lastIndexOf(':'));
    if (data?.type === 'mcp-notification' && (!data.hostId || data.hostId === hostId) && ['thread/started', 'thread/resumed', 'thread/name/updated', 'thread/status/changed', 'turn/started', 'turn/completed'].includes(notification.method)) {
      const threadId = notification.params?.threadId || notification.params?.thread?.id;
      if (!threadId || identity()?.split(':').at(-1) === threadId) void hydrate(true).catch(failed);
    }
  };
  window.addEventListener('message', onMessage); window.addEventListener('popstate', schedule);
  window[key] = {
    handoffs: { colors: Boolean(externalColors), font: Boolean(externalFont) },
    onContext(listener) { contextListeners.add(listener); if (lastContext) listener(lastContext); return () => contextListeners.delete(listener); },
    update(next) { map = next; return paint(); },
    refresh() { assets = createNativeAssetReader(document); servicesPromise = null; return refresh(true).then(value => { errors.delete('renderer'); return paint() || value; }).catch(failure => { failed(failure); throw failure; }); },
    cleanup() {
      stopped = true; observer.disconnect(); window.removeEventListener('message', onMessage); window.removeEventListener('popstate', schedule);
      bridge.close();
      for (const name of ownClasses) toggle(name, false);
      if (!externalColors) for (const channel of channels) document.documentElement.style.removeProperty('--cdtk-' + channel);
      for (const listener of contextListeners) listener(null); contextListeners.clear();
      document.getElementById(styleId)?.remove(); delete window[key];
    },
  };
  schedule(); return paint();
}
