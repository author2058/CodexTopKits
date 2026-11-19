export function createScrollKit({ document, onDomChange, dispatch, reportError }, helpers, id) {
  const { readNativeConversationIdentity, readNativeNotification, installScrollHandoffRepair, scrollHandoffCorrection, installScrollDiagnostics } = helpers;
  const view = document.defaultView, callbacks = new Set(), runId = view.crypto.randomUUID();
  let main, control, observer;
  const current = () => readNativeConversationIdentity(document);
  const notifications = { addNotificationCallback(methods, listener) {
    const entry = { methods, listener }; callbacks.add(entry); return () => callbacks.delete(entry);
  } };
  const receive = event => {
    if (event.source && event.source !== view || event.data?.type !== 'mcp-notification') return;
    const method = event.data.notification?.method ?? event.data.method;
    if (!['turn/started', 'turn/completed', 'thread/status/changed', 'item/started', 'item/completed'].includes(method)) return;
    try {
      if (event.data.hostId && event.data.hostId !== (current()?.hostId || 'local')) return;
      const notification = readNativeNotification(event.data);
      for (const callback of callbacks) if (callback.methods.includes(method)) callback.listener(notification);
    } catch (error) { reportError(error, 'notification'); }
  };
  const unmount = () => {
    observer?.disconnect(); observer = null; view.removeEventListener('message', receive);
    control?.cleanup(); control = null; callbacks.clear(); main = null;
  };
  const watch = 'main,[class*="_Workspace_"],[data-codex-composer-root],[data-app-action-timeline-scroll],.thread-scroll-container,[role="tabpanel"][data-tab-id],[data-above-composer-conversation-id]';
  const owned = node => node?.nodeType === 1 && (node.hasAttribute('data-cdtk-owned') || node.closest('[data-cdtk-owned],[data-cdtk-chat-owned]'));
  const changed = records => records.some(record => {
    if (owned(record.target)) return false;
    if (record.type === 'attributes') return record.target.matches?.(watch);
    return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && !owned(node) && (node.matches?.(watch) || node.querySelector?.(watch)));
  });
  const refresh = () => {
    if (control && main?.isConnected && main.matches('main.main-surface,main[class*="MainContentSurface"]')
      && !main.closest('[data-app-shell-tab-panel-controller="right"]') && view.location.pathname !== '/detached-window.html') return;
    if (control) unmount();
    if (view.location.pathname === '/detached-window.html') return;
    main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (!main) return;
    try {
      const feature = id === 'scroll-handoff-fix' ? 'scroll-handoff' : 'scroll';
      const report = record => dispatch({ kind: 'chat-diagnostic', feature, record });
      const failure = error => reportError(error, feature);
      control = id === 'scroll-handoff-fix' ? installScrollHandoffRepair(document, scrollHandoffCorrection, report, failure)
        : installScrollDiagnostics(document, notifications, report, failure, runId);
      if (id === 'scroll-diagnostics') view.addEventListener('message', receive);
      observer = new view.MutationObserver(records => { if (changed(records)) { refresh(); control?.refresh(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state', 'data-tab-id', 'data-above-composer-conversation-id'] });
    } catch (error) { unmount(); throw error; }
  };
  const unsubscribe = onDomChange(refresh);
  try { refresh(); } catch (error) { unsubscribe(); unmount(); throw error; }
  return { close() { unsubscribe(); unmount(); } };
}
