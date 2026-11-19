export function installWindowProbe(window, targetId, binding, helpers) {
  const key = '__CODEXTOPKITS_WINDOW_PROBE__';
  if (window[key]) { window[key].schedule(); return true; }
  const document = window.document, bridge = helpers.createNativeBridgeClient(window);
  let metadata, loading, desired, stopped = false, scheduled = false, last;
  const send = value => { if (!stopped && typeof window[binding] === 'function') window[binding](JSON.stringify(value)); };
  const identity = () => helpers.readNativeConversationIdentity(document);
  const applicable = () => window.location.pathname !== '/detached-window.html' && [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(node => !node.closest('[data-app-shell-tab-panel-controller="right"]'));
  const report = error => {
    const current = identity(), active = metadata?.taskKey === current?.taskKey ? metadata : null;
    const value = { kind: 'window-state', applicable: applicable(), focused: document.hasFocus(), taskKey: current?.taskKey || null,
      title: active?.title || current?.seed?.displayTitle || document.title.trim() || '新聊天', status: active?.status || null,
      color: window.getComputedStyle(document.documentElement).getPropertyValue('--cdtk-accent').trim() || '#7d8695',
      error: error ? { name: error.name, message: error.message, stack: error.stack, code: error.code } : null };
    const signature = JSON.stringify(value); if (signature !== last) { last = signature; send(value); }
  };
  const hydrate = async force => {
    const current = identity(); desired = current?.taskKey;
    if (!current || !applicable()) { metadata = null; report(); return; }
    if (loading) { await loading; if (!stopped && desired !== metadata?.taskKey) return hydrate(false); return; }
    if (!force && metadata?.taskKey === current.taskKey) return;
    loading = (async () => {
      const result = await bridge.appServer('thread/read', { threadId: current.threadId, includeTurns: false }, { hostId: current.hostId, source: 'codextopkits_windows' });
      if (result?.thread?.id !== current.threadId) throw new Error('会话信息返回了不同的线程 ID。');
      if (!stopped && identity()?.taskKey === current.taskKey) { metadata = { taskKey: current.taskKey, title: result.thread.name || result.thread.title || current.seed?.displayTitle || current.threadId, status: result.thread.status?.type || null }; report(); }
    })();
    try { await loading; } finally { loading = null; }
    if (!stopped && identity()?.taskKey !== current.taskKey) await hydrate(false);
  };
  const refresh = () => { report(); return hydrate(false); };
  const schedule = () => { if (!scheduled && !stopped) { scheduled = true; window.queueMicrotask(() => { scheduled = false; void refresh().catch(report); }); } };
  const observer = new window.MutationObserver(records => {
    if (records.some(record => !record.target.closest?.('[data-cdtk-owned]')
      && (!record.addedNodes?.length && !record.removedNodes?.length || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && !node.hasAttribute('data-cdtk-owned'))))) schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'data-above-composer-conversation-id', 'data-app-action-sidebar-thread-active'] });
  const title = document.querySelector('title'), titleObserver = new window.MutationObserver(schedule);
  if (title) titleObserver.observe(title, { childList: true, characterData: true, subtree: true });
  const receive = event => {
    if (event.source && event.source !== window || event.data?.type !== 'mcp-notification') return;
    try {
      const { method, params } = helpers.readNativeNotification(event.data), hostId = event.data.hostId || 'local';
      const threadId = params.threadId || params.thread?.id;
      if (['turn/started', 'turn/completed', 'thread/started', 'thread/status/changed', 'thread/closed'].includes(method)) {
        send({ kind: 'window-activity', hostId, method, params: { threadId, turnId: params.turnId || params.turn?.id, turnStatus: params.turnStatus || params.turn?.status, status: params.status || params.thread?.status } });
        const current = identity(); if (current?.hostId === hostId && current.threadId === threadId && metadata?.taskKey === current.taskKey) { metadata.status = params.status?.type || params.thread?.status?.type || (method === 'turn/started' ? 'active' : 'idle'); report(); }
      }
      if (method === 'thread/name/updated' && identity()?.threadId === threadId) void hydrate(true).catch(report);
    } catch (error) { report(error); }
  };
  const events = [['focus', () => report()], ['blur', () => report()], ['popstate', schedule], ['message', receive]];
  for (const [name, listener] of events) window.addEventListener(name, listener);
  window[key] = { refresh, schedule, readActivity: source => helpers.readSleepActivity((method, params) => bridge.appServer(method, params, { source }), source),
    close() { stopped = true; observer.disconnect(); titleObserver.disconnect(); bridge.close(); for (const [name, listener] of events) window.removeEventListener(name, listener); delete window[key]; } };
  schedule(); return true;
}
