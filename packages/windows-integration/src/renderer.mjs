export function installWindowsRenderer(window, initial, helpers) {
  const key = '__CODEX_DESKTOP_TOOLKIT_WINDOWS__', binding = '__CDTK_WINDOWS_BRIDGE__', styleId = 'cdtk-windows-style';
  const document = window.document;
  if (window !== window.top) return { applicable: false };
  if (window.__CODEX_DYNAMIC_THEME__) throw new Error('旧控制器仍在此页面运行；请先停止旧注入，再启用窗口集成。');
  if (window[key]?.epoch === initial.epoch) return window[key].setState(initial);
  window[key]?.cleanup();
  if (document.readyState === 'loading') {
    let latest = initial;
    const start = () => { delete window[key]; try { installWindowsRenderer(window, latest, helpers); } catch (error) { window[binding](JSON.stringify({ kind: 'state', applicable: false, errors: [{ source: 'startup', name: error.name, message: error.message, stack: error.stack }] })); } };
    window[key] = { epoch: initial.epoch, setState(value) { latest = value; }, cleanup() { document.removeEventListener('DOMContentLoaded', start); delete window[key]; } };
    document.addEventListener('DOMContentLoaded', start, { once: true }); return { pending: true };
  }
  const { acquireFooter, createNativeBridgeClient, createNativeAssetReader, loadNativeAppServices, loadNativeConversationRpc, readNativeConversationIdentity, readNativeNotification, middleEllipsis, readSleepActivity, installReadAloudMenu, installHostedUpdateControl, updateIndicatorCss, loadNativeCloudUnread, installCloudUnreadControl, windowTabsCss, autoSleepCss, cloudReadCss } = helpers;
  const bridge = createNativeBridgeClient(window), errors = new Map(), measurements = new Map();
  const requests = new Map();
  let state = initial, stopped = false, scheduled = false, footer, picker, moon, style, measure, metadata = null, loading = null, desiredKey = null, lastReport = null;
  let readAloud, update, updateReady;
  let unread, unreadReady, envelope;
  const visible = element => element?.getClientRects().length && window.getComputedStyle(element).visibility !== 'hidden';
  const applicable = () => window.location.pathname !== '/detached-window.html' && [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
  const identity = () => readNativeConversationIdentity(document);
  const dotWindowTitle = () => {
    const surface = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(visible);
    let fiber = surface?.[Object.keys(surface).find(key => key.startsWith('__reactFiber'))];
    const seen = new Set();
    while (fiber && !seen.has(fiber)) {
      seen.add(fiber);
      const pathname = fiber.memoizedProps?.value?.location?.pathname;
      if (typeof pathname === 'string') return pathname.startsWith('/dots/') ? document.title.trim() : null;
      fiber = fiber.return;
    }
    return null;
  };
  const send = value => {
    if (stopped) return;
    if (typeof window[binding] !== 'function') throw new Error('窗口集成的控制器连接不可用。');
    window[binding](JSON.stringify(value));
  };
  const report = () => {
    const current = identity(), thread = metadata?.taskKey === current?.taskKey ? metadata : null;
    const value = { kind: 'state', applicable: applicable(), focused: document.hasFocus(), taskKey: current?.taskKey || null,
      title: thread?.title || current?.seed?.displayTitle || dotWindowTitle() || (current ? '加载会话…' : '新聊天'), status: thread?.status || null,
      color: window.getComputedStyle(document.documentElement).getPropertyValue('--cdtk-accent').trim() || '#7d8695',
      readAloud: readAloud?.status(), updateProtection: update?.status(),
      cloudUnread: unread?.status(),
      errors: [...errors].map(([source, error]) => ({ source, name: error.name, message: error.message, stack: error.stack })) };
    const signature = JSON.stringify(value); if (lastReport !== signature) { lastReport = signature; send(value); }
    return value;
  };
  const failed = source => error => { if (!stopped) { errors.set(source, error); report(); } };
  const hydrate = async force => {
    const current = identity(); desiredKey = current?.taskKey || null;
    if (!current || !applicable()) { metadata = null; errors.delete('thread'); report(); return; }
    if (loading) { await loading; if (!stopped && desiredKey !== metadata?.taskKey) return hydrate(false); return; }
    if (!force && metadata?.taskKey === current.taskKey) return;
    loading = (async () => {
      const result = await bridge.appServer('thread/read', { threadId: current.threadId, includeTurns: false }, { hostId: current.hostId, source: 'codex_toolkit_windows' });
      if (result?.thread?.id !== current.threadId) throw new Error('会话信息返回了不同的线程 ID。');
      if (!stopped && identity()?.taskKey === current.taskKey) {
        metadata = { taskKey: current.taskKey, title: result.thread.name || result.thread.title || current.seed?.displayTitle || current.threadId, status: result.thread.status?.type || null };
        errors.delete('thread'); report();
      }
    })();
    try { await loading; } finally { loading = null; }
    if (!stopped && identity()?.taskKey !== current.taskKey) await hydrate(false);
  };
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const attribute = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
  const render = () => {
    if (stopped) return;
    if (!applicable()) { picker?.remove(); moon?.remove(); envelope?.remove(); measure?.remove(); footer?.release(); footer = picker = moon = envelope = measure = null; report(); return; }
    if (!style) {
      style = document.createElement('style'); style.id = styleId;
      style.textContent = (state.externalFooter ? '' : windowTabsCss() + autoSleepCss() + cloudReadCss()) + (state.externalKits?.includes('update-restart-protection') ? '' : updateIndicatorCss());
      document.head.appendChild(style);
      if (!state.externalKits?.includes('markdown-edge-read-aloud')) readAloud = installReadAloudMenu(document, send, failed('read-aloud-menu'));
    }
    try { readAloud?.refresh(); errors.delete('read-aloud-menu'); } catch (error) { failed('read-aloud-menu')(error); }
    if (!state.externalKits?.includes('update-restart-protection') && !updateReady) {
      updateReady = loadNativeAppServices(document, { assets: createNativeAssetReader(document) }).then(services => {
        if (stopped) return;
        if (typeof services?.appUpdates?.installUpdate !== 'function') throw new Error('Codex 原生更新接口不可用。');
        update = installHostedUpdateControl(window, { services }, {
          registerRestart: () => new Promise((resolve, reject) => {
            const requestId = window.crypto.randomUUID(); requests.set(requestId, { resolve, reject });
            try { send({ kind: 'restart-protection', requestId }); } catch (error) { requests.delete(requestId); reject(error); }
          }), onStatus: report, onError: failed('update-protection'),
        });
        return update.ready;
      }).catch(failed('update-protection'));
    }
    update?.refreshButtons();
    if (!state.externalFooter && !unreadReady) {
      const assets = createNativeAssetReader(document);
      unreadReady = loadNativeConversationRpc(document, { assets }).then(nativeHost => loadNativeCloudUnread(document, { assets, nativeHost })).then(host => {
        if (stopped) return;
        unread = installCloudUnreadControl(host.readState, host.badgeStore, host.markRead, () => {
          errors.delete('cloud-unread'); schedule();
        });
        errors.delete('cloud-unread'); schedule();
      }).catch(failed('cloud-unread'));
    }
    if (state.externalFooter) { report(); return; }
    if (!footer) {
      footer = acquireFooter(document, 'windows', state.hostState);
      picker = document.createElement('div'); picker.id = 'cdtk-window-switcher'; picker.setAttribute('role', 'toolbar'); picker.setAttribute('aria-label', '切换 Codex 窗口'); footer.center.appendChild(picker);
      picker.addEventListener('click', event => { const button = event.target.closest('button[data-target-id]'); if (!button) return; event.preventDefault(); send({ kind: 'activate', targetId: button.dataset.targetId }); });
      moon = document.createElement('button'); moon.id = 'cdtk-window-' + state.targetId; moon.type = 'button'; moon.className = 'cdtk-auto-sleep'; moon.textContent = '🌙';
      moon.addEventListener('click', () => send({ kind: 'sleep-toggle', enabled: !state.autoSleep?.enabled })); footer.right.appendChild(moon);
      envelope = document.createElement('button'); envelope.type = 'button'; envelope.className = 'cdtk-clear-cloud-unread';
      envelope.setAttribute('title', '清理云端未读'); envelope.setAttribute('aria-label', '清理云端未读');
      envelope.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m3 10 9-7 9 7v10H3z"/><path d="m3 10 9 7 9-7M7 13V7h10v6"/></svg>';
      envelope.addEventListener('click', () => {
        if (!unread) { failed('cloud-unread')(new Error('云端未读接口尚未连接，请在设置页查看详情。')); return; }
        void unread.clear().then(() => { errors.delete('cloud-unread'); render(); }).catch(failed('cloud-unread'));
      }); footer.right.appendChild(envelope);
      measure = document.createElement('span'); measure.dataset.cdtkWindowsOwned = ''; measure.setAttribute('aria-hidden', 'true');
      measure.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;white-space:pre;left:-9999px;top:-9999px'; document.body.appendChild(measure);
    }
    footer.setHostState(state.hostState);
    const clearingUnread = unread?.status().busy === true;
    if (envelope.disabled !== clearingUnread) envelope.disabled = clearingUnread;
    const rows = state.windows || [], ids = new Set(rows.map(value => value.targetId));
    for (const node of [...picker.children]) if (!ids.has(node.dataset.targetId)) node.remove();
    for (const [index, entry] of rows.entries()) {
      let button = [...picker.children].find(node => node.dataset.targetId === entry.targetId);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'cdtk-window-tab'; button.dataset.targetId = entry.targetId;
        const label = document.createElement('span'), status = document.createElement('span'); label.className = 'cdtk-window-label'; status.className = 'cdtk-window-status'; button.append(label, status);
        picker.insertBefore(button, picker.children[index] || null);
      }
      attribute(button, 'aria-current', String(entry.targetId === state.targetId)); attribute(button, 'title', entry.title);
      if (button.style.getPropertyValue('--cdtk-window-color') !== entry.color) button.style.setProperty('--cdtk-window-color', entry.color);
      const label = button.firstElementChild, status = button.lastElementChild, computed = window.getComputedStyle(label);
      const cacheKey = JSON.stringify([entry.title, computed.font, computed.letterSpacing, computed.wordSpacing]);
      if (!measurements.has(cacheKey)) {
        measure.style.font = computed.font; measure.style.letterSpacing = computed.letterSpacing; measure.style.wordSpacing = computed.wordSpacing;
        measurements.set(cacheKey, middleEllipsis(entry.title, 190, value => { text(measure, value); return Math.ceil(measure.getBoundingClientRect().width); }));
      }
      text(label, measurements.get(cacheKey));
      const markup = entry.status === 'active' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="正在运行"><path d="M12 3a9 9 0 1 1-8.5 12"/><path d="M4 4v5h5"/></svg>'
        : entry.unread ? '<svg viewBox="0 0 24 24" aria-label="未读"><circle cx="12" cy="12" r="5" fill="#60a5fa"/></svg>' : '';
      const statusName = entry.status === 'active' ? 'running' : entry.unread ? 'unread' : 'idle';
      if (status.dataset.state !== statusName) { status.dataset.state = statusName; status.innerHTML = markup; }
    }
    attribute(moon, 'aria-pressed', String(state.autoSleep?.enabled === true)); attribute(moon, 'data-error', String(Boolean(state.autoSleep?.error)));
    const title = state.autoSleep?.error ? '自动睡眠失败：' + state.autoSleep.error : state.autoSleep?.enabled ? '全部会话结束并静置一分钟后睡眠；点击取消' : '自动睡眠已关闭，点击开启';
    attribute(moon, 'title', title); attribute(moon, 'aria-label', title); report();
  };
  const schedule = () => { if (!scheduled && !stopped) { scheduled = true; window.queueMicrotask(() => { scheduled = false; render(); void hydrate(false).catch(failed('thread')); }); } };
  const watch = 'main,[class*="_Workspace_"],[data-codex-composer-root],[data-above-composer-conversation-id],[data-app-action-sidebar-thread-active],header,file-tree-container,button';
  const observer = new window.MutationObserver(records => {
    if (records.some(record => {
      if (record.target.closest?.('#codex-usage-toolbar,[data-cdtk-windows-owned],#' + styleId) || record.target.parentElement?.id === styleId) return false;
      if (record.type === 'attributes') return record.target === document.documentElement || record.target.matches?.(watch);
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches?.(watch) || node.querySelector?.(watch)));
    })) schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'aria-current', 'data-above-composer-conversation-id', 'data-app-action-sidebar-thread-active'] });
  const focus = () => { report(); };
  const titleObserver = new window.MutationObserver(schedule);
  const titleElement = document.querySelector('title');
  if (titleElement) titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
  const receive = event => {
    if (event.source && event.source !== window || event.data?.type !== 'mcp-notification') return;
    try {
    const { method, params } = readNativeNotification(event.data);
    if (['turn/started', 'turn/completed', 'thread/started', 'thread/status/changed', 'thread/closed'].includes(method)) send({ kind: 'activity', method, params, hostId: event.data.hostId || 'local' });
    const current = identity(), threadId = params.threadId || params.thread?.id;
    if (current && (!event.data.hostId || event.data.hostId === current.hostId) && current.threadId === threadId) {
      if (method === 'thread/name/updated') void hydrate(true).catch(failed('thread'));
      if (metadata?.taskKey === current.taskKey && ['turn/started', 'turn/completed', 'thread/status/changed'].includes(method)) {
        metadata.status = params.status?.type || (method === 'turn/started' ? 'active' : 'idle'); report();
      }
    }
    } catch (error) { failed('notification')(error); }
  };
  window.addEventListener('message', receive); window.addEventListener('focus', focus); window.addEventListener('blur', focus); window.addEventListener('popstate', schedule); window.addEventListener('resize', schedule);
  window[key] = {
    handoffs: { readAloud: Boolean(state.externalKits?.includes('markdown-edge-read-aloud')), updateProtection: Boolean(state.externalKits?.includes('update-restart-protection')) },
    epoch: initial.epoch,
    setState(value) { state = value; render(); return true; },
    refresh() { render(); return hydrate(true).then(report); },
    resolveRestart(requestId, result, error) { const request = requests.get(requestId); if (!request) return false; requests.delete(requestId); error ? request.reject(Object.assign(new Error(error.message), error)) : request.resolve(result); return true; },
    readSleepActivity: (source, readId) => readSleepActivity((method, params) => bridge.appServer(method, params, { source }), source, readId ? value => {
      // A diagnostic delivery failure must not replace the activity result/error.
      try { send({ kind: 'activity-read-timing', readId, source, ...value }); }
      catch (error) { console.error('Activity timing delivery failed:', error); }
    } : undefined),
    cleanup() {
      stopped = true; observer.disconnect(); titleObserver.disconnect(); readAloud?.cleanup(); update?.cleanup(); unread?.cleanup(); bridge.close(); window.removeEventListener('message', receive); window.removeEventListener('focus', focus); window.removeEventListener('blur', focus); window.removeEventListener('popstate', schedule); window.removeEventListener('resize', schedule);
      for (const request of requests.values()) request.reject(new Error('Windows 集成已停止。')); requests.clear();
      picker?.remove(); moon?.remove(); envelope?.remove(); measure?.remove(); style?.remove(); footer?.release(); delete window[key];
    },
  };
  schedule(); return report();
}
