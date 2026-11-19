import manifest from './kit.json' with { type: 'json' };
import { createNativeAssetReader, loadNativeConversationRpc, readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import { findNativeConversationStore } from '../../src/native-client.mjs';
import { installComposerUi } from '../../src/composer-ui.mjs';
import { nativeComposerTiming, createRpcComposerTiming, nativeWorkedTiming, composerIsWorking, loadNativeDurationFormatter } from '../../src/composer-timer.mjs';
import { composerTimerCss } from '../../src/styles.mjs';

export const createComposerTimer = ({ document, onDomChange, dispatch, reportError, i18n }, helpers) => {
  if (typeof i18n?.onChange !== 'function') throw new Error('composer-timer requires Core 0.3.39 or later.');
  const { createNativeAssetReader, loadNativeConversationRpc, readNativeConversationIdentity, readNativeNotification, findNativeConversationStore,
    installComposerUi, loadNativeDurationFormatter, composerTimerCss } = helpers;
  const view = document.defaultView, style = document.createElement('style'), listeners = new Set();
  style.setAttribute('data-cdtk-owned', 'composer-timer');
  style.textContent = composerTimerCss() + '.cdtk-composer-timer-hidden .codex-composer-running-bar::before{animation-play-state:paused!important}';
  let main, composer, observer, client, rpc, formatter, loading = false, stopped = false;
  const current = () => readNativeConversationIdentity(document);
  const getClient = () => {
    const hostId = current()?.hostId || 'local';
    if (!client || client.disposed || client.hostId !== hostId) client = findNativeConversationStore(document.getElementById('root'), hostId);
    return client;
  };
  const visibility = () => {
    if (document.documentElement.classList.contains('cdtk-composer-timer-hidden') !== document.hidden) document.documentElement.classList.toggle('cdtk-composer-timer-hidden', document.hidden);
  };
  const changed = () => { view.__CODEX_DESKTOP_TOOLKIT_CHAT__?.refreshLiveOutput?.(); for (const listener of listeners) listener(); };
  const receive = event => {
    if (event.source && event.source !== view || event.data?.type !== 'mcp-notification') return;
    const method = event.data.notification?.method ?? event.data.method;
    if (!['turn/started', 'turn/completed', 'thread/status/changed', 'thread/resumed', 'item/started', 'item/completed'].includes(method)) return;
    try {
      const notification = readNativeNotification(event.data);
      if (event.data.hostId && event.data.hostId !== (current()?.hostId || 'local')) return;
      composer?.receive(notification.method, notification.params);
    } catch (error) { reportError(error, 'notification'); }
  };
  const unmount = () => {
    const mounted = Boolean(composer);
    observer?.disconnect(); observer = null; view.removeEventListener('message', receive); document.removeEventListener('visibilitychange', visibility);
    composer?.cleanup(); composer = null; main = null; style.remove(); document.documentElement.classList.remove('cdtk-composer-timer-hidden');
    if (mounted) changed();
  };
  const watch = 'main,[class*="_Workspace_"],[data-codex-composer-root],[data-app-action-timeline-scroll],.thread-scroll-container,[role="tabpanel"][data-tab-id],[data-above-composer-conversation-id]';
  const owned = node => node?.nodeType === 1 && (node.hasAttribute('data-cdtk-owned') || node.closest('[data-cdtk-owned],[data-cdtk-chat-owned],.codex-composer-running-bar,.codex-live-output-overlay'));
  const changedDom = records => records.some(record => {
    if (owned(record.target)) return false;
    if (record.type === 'attributes') return record.target.matches?.(watch);
    return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && !owned(node) && (node.matches?.(watch) || node.querySelector?.(watch)));
  });
  const loadNative = () => {
    if (loading) return; loading = true;
    const assets = createNativeAssetReader(document);
    void loadNativeConversationRpc(document, { assets }).then(value => {
      if (!stopped) { rpc = value; composer?.ready(); reportError(null, 'conversation-rpc'); }
    }).catch(error => { if (!stopped) reportError(error, 'conversation-rpc'); });
    void loadNativeDurationFormatter(document, { assets }).then(value => {
      if (!stopped) { formatter = value; composer?.refresh(); reportError(null, 'duration-formatter'); }
    }).catch(error => { if (!stopped) reportError(error, 'duration-formatter'); });
  };
  const refresh = () => {
    if (composer && main?.isConnected && main.matches('main.main-surface,main[class*="MainContentSurface"]')
      && !main.closest('[data-app-shell-tab-panel-controller="right"]') && view.location.pathname !== '/detached-window.html') return;
    if (composer) unmount();
    if (view.location.pathname === '/detached-window.html') return;
    main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (!main) return;
    document.head.appendChild(style);
    try {
      composer = installComposerUi(document, { getClient, getRpc: () => rpc?.forHost(current()?.hostId || 'local') || null,
        currentThread: () => current()?.taskKey || null, getFormatter: () => formatter, getLocale: () => i18n.locale,
        onError: error => reportError(error, 'timer'), onDiagnostic: record => dispatch({ kind: 'chat-diagnostic', feature: 'timer', record }), changed }, helpers);
      view.addEventListener('message', receive); document.addEventListener('visibilitychange', visibility); visibility();
      observer = new view.MutationObserver(records => { if (changedDom(records)) { refresh(); composer?.refresh(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state', 'data-tab-id', 'data-above-composer-conversation-id'] });
      loadNative(); if (rpc) composer.ready();
    } catch (error) { unmount(); throw error; }
  };
  let unsubscribe, unsubscribeLocale;
  try { unsubscribeLocale = i18n.onChange(() => composer?.renderText()); unsubscribe = onDomChange(refresh); refresh(); }
  catch (error) { stopped = true; unsubscribe?.(); unsubscribeLocale?.(); unmount(); throw error; }
  return { onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { stopped = true; unsubscribe(); unsubscribeLocale(); unmount(); listeners.clear(); } };
};

export default { manifest, create: createComposerTimer, helpers: { createNativeAssetReader, loadNativeConversationRpc, readNativeConversationIdentity,
  readNativeNotification, findNativeConversationStore, installComposerUi, nativeComposerTiming, createRpcComposerTiming,
  nativeWorkedTiming, composerIsWorking, loadNativeDurationFormatter, composerTimerCss } };
