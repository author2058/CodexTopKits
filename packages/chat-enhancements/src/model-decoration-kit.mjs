export function createDecorationsKit({ document, onDomChange, reportError, i18n }, helpers, id) {
  if (id === 'fast-mode-indicator' && (!i18n?.t || !i18n?.onChange)) throw new Error('fast-mode-indicator requires Core 0.3.39 localization.');
  const { createNativeBridgeClient, readNativeConversationIdentity, readNativeNotification, installModelDecorations,
    readComposerModelSelection, sameModelSelection, modelDecorationsCss } = helpers;
  const view = document.defaultView, style = document.createElement('style');
  const features = { emoji: id === 'title-emoji', fast: id === 'fast-mode-indicator', warning: id === 'child-model-warning' };
  style.setAttribute('data-cdtk-owned', id); style.textContent = modelDecorationsCss(features);
  let main, decorations, bridge, observer;
  const current = () => readNativeConversationIdentity(document);
  const receive = event => {
    if (event.source && event.source !== view || event.data?.type !== 'mcp-notification') return;
    const method = event.data.notification?.method ?? event.data.method;
    if (!['thread/name/updated', 'thread/settings/updated', 'thread/started', 'turn/started'].includes(method)) return;
    try {
      if (event.data.hostId && event.data.hostId !== (current()?.hostId || 'local')) return;
      const notification = readNativeNotification(event.data); decorations?.receive(notification.method, notification.params);
    } catch (error) { reportError(error, 'notification'); }
  };
  const unmount = () => {
    observer?.disconnect(); observer = null; view.removeEventListener('message', receive);
    decorations?.cleanup(); decorations = null; bridge?.close(); bridge = null; main = null; style.remove();
  };
  const watch = 'main,[class*="_Workspace_"],[data-codex-composer-root],[data-app-action-timeline-scroll],.thread-scroll-container,[role="tabpanel"][data-tab-id],[data-above-composer-conversation-id],[data-codex-intelligence-trigger="true"],[data-composer-navigation-target="reasoning"]';
  const owned = node => node?.nodeType === 1 && (node.hasAttribute('data-cdtk-owned') || node.closest('[data-cdtk-owned],[data-cdtk-chat-owned]'));
  const changed = records => records.some(record => {
    if (owned(record.target)) return false;
    if (record.type === 'attributes') return record.target.matches?.(watch);
    return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && !owned(node) && (node.matches?.(watch) || node.querySelector?.(watch)));
  });
  const refresh = () => {
    if (decorations && main?.isConnected && main.matches('main.main-surface,main[class*="MainContentSurface"]')
      && !main.closest('[data-app-shell-tab-panel-controller="right"]') && view.location.pathname !== '/detached-window.html') return;
    if (decorations) unmount();
    if (view.location.pathname === '/detached-window.html') return;
    main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (!main) return;
    document.head.appendChild(style);
    try {
      bridge = createNativeBridgeClient(view);
      decorations = installModelDecorations(document, { currentThread: () => current()?.taskKey || null, currentHost: () => current()?.hostId || 'local',
        bridge, onError: error => reportError(error, 'decorations'), features,
        ...(features.fast ? { fastLabel: () => i18n.t({ en: { fast: 'Fast' }, 'zh-Hans': { fast: '快速' } }, 'fast') } : {}) }, readComposerModelSelection, sameModelSelection);
      view.addEventListener('message', receive);
      observer = new view.MutationObserver(records => { if (changed(records)) { refresh(); decorations?.refresh(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state', 'data-tab-id', 'data-above-composer-conversation-id', 'data-codex-intelligence-trigger', 'data-composer-navigation-target'] });
      decorations.refresh();
    } catch (error) { unmount(); throw error; }
  };
  const unsubscribe = onDomChange(refresh);
  let unsubscribeLocale;
  try { if (features.fast) unsubscribeLocale = i18n.onChange(() => decorations?.updateText()); refresh(); } catch (error) { unsubscribeLocale?.(); unsubscribe(); unmount(); throw error; }
  return { close() { unsubscribeLocale?.(); unsubscribe(); unmount(); } };
}
