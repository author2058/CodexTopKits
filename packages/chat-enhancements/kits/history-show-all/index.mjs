import manifest from './kit.json' with { type: 'json' };
import { createNativeAssetReader, loadNativeConversationRpc, readNativeConversationIdentity } from 'codex-toolkit-core/renderer';
import { findNativeConversationStore } from '../../src/native-client.mjs';
import { installTurnHistoryControl, readTurnHistoryDisclosure } from '../../src/turn-history.mjs';
import { speedHistoryCss, historyControlCss } from '../../src/styles.mjs';

export const createHistoryShowAll = ({ document, onDomChange, reportError, i18n }, helpers) => {
  if (!i18n?.t || !i18n?.onChange) throw new Error('history-show-all requires Core 0.3.39 localization.');
  const { createNativeAssetReader, loadNativeConversationRpc, readNativeConversationIdentity, findNativeConversationStore,
    installTurnHistoryControl, readTurnHistoryDisclosure, speedHistoryCss, historyControlCss } = helpers;
  const view = document.defaultView, style = document.createElement('style');
  style.setAttribute('data-cdtk-owned', 'history-show-all');
  style.textContent = speedHistoryCss('.codex-turn-history-all') + historyControlCss();
  let main, history, client, rpc, loading = false, stopped = false;
  const messages = { en: { show: 'Show all', loading: 'Loading all output for this turn', load: 'Load all history items for this turn' },
    'zh-Hans': { show: '显示全部', loading: '正在加载本轮完整输出', load: '加载本轮全部历史条目' } };
  const current = () => readNativeConversationIdentity(document);
  const getClient = () => {
    const hostId = current()?.hostId || 'local';
    if (!client || client.disposed || client.hostId !== hostId) client = findNativeConversationStore(document.getElementById('root'), hostId);
    return client;
  };
  const loadNative = () => {
    if (loading) return;
    loading = true;
    void loadNativeConversationRpc(document, { assets: createNativeAssetReader(document) }).then(value => {
      if (!stopped) { rpc = value; history?.refresh(); reportError(null, 'conversation-rpc'); }
    }).catch(error => { if (!stopped) reportError(error, 'conversation-rpc'); });
  };
  const unmount = () => { history?.cleanup(); history = null; main = null; style.remove(); };
  const refresh = () => {
    if (history && main?.isConnected && main.matches('main.main-surface,main[class*="MainContentSurface"]')
      && !main.closest('[data-app-shell-tab-panel-controller="right"]') && view.location.pathname !== '/detached-window.html') return;
    if (history) unmount();
    if (view.location.pathname === '/detached-window.html') return;
    main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (!main) return;
    document.head.appendChild(style);
    try {
      history = installTurnHistoryControl(document, getClient, readTurnHistoryDisclosure, error => reportError(error, 'history'), () => rpc?.forHost(current()?.hostId || 'local') || null, key => i18n.t(messages, key));
      loadNative(); if (rpc) history.refresh();
    } catch (error) { unmount(); throw error; }
  };
  const unsubscribe = onDomChange(refresh);
  let unsubscribeLocale;
  try { unsubscribeLocale = i18n.onChange(() => history?.updateText()); refresh(); } catch (error) { unsubscribeLocale?.(); unsubscribe(); unmount(); throw error; }
  return { close() { stopped = true; unsubscribeLocale(); unsubscribe(); unmount(); } };
};

export default { manifest, create: createHistoryShowAll, helpers: { createNativeAssetReader, loadNativeConversationRpc, readNativeConversationIdentity,
  findNativeConversationStore, installTurnHistoryControl, readTurnHistoryDisclosure, speedHistoryCss, historyControlCss } };
