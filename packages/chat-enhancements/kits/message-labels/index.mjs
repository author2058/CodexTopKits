import manifest from './kit.json' with { type: 'json' };
import { readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import { findNativeConversationStore } from '../../src/native-client.mjs';
import { installMessageLabels, assistantMessageOrdinals, messageLabelTime, messageOrdinalColor } from '../../src/message-labels.mjs';
import { messageLabelsCss } from '../../src/styles.mjs';

export const createMessageLabels = ({ document, onDomChange, dispatch, reportError }, helpers) => {
  const { readNativeConversationIdentity, readNativeNotification, findNativeConversationStore, installMessageLabels,
    assistantMessageOrdinals, messageLabelTime, messageOrdinalColor, messageLabelsCss } = helpers;
  const view = document.defaultView, key = '__CODEXTOPKITS_MESSAGE_LABELS__', style = document.createElement('style'), requests = new Map();
  style.setAttribute('data-cdtk-owned', 'message-labels'); style.textContent = messageLabelsCss();
  let main, labels, client;
  const current = () => readNativeConversationIdentity(document);
  const getClient = () => {
    const hostId = current()?.hostId || 'local';
    if (!client || client.disposed || client.hostId !== hostId) client = findNativeConversationStore(document.getElementById('root'), hostId);
    return client;
  };
  const endpoint = { resolve(requestId, result, error) {
    const request = requests.get(requestId); if (!request) return false;
    requests.delete(requestId);
    if (error) request.reject(Object.assign(new Error(error.message), error));
    else { reportError(null, 'labels'); request.resolve(result); }
    return true;
  } };
  const loadIndex = identity => new Promise((resolve, reject) => {
    const requestId = view.crypto.randomUUID(); requests.set(requestId, { resolve, reject });
    try { dispatch({ kind: 'history-index', requestId, ...identity }); }
    catch (error) { requests.delete(requestId); reject(error); }
  });
  const receive = event => {
    if (event.source && event.source !== view || event.data?.type !== 'mcp-notification') return;
    const method = event.data.notification?.method ?? event.data.method;
    if (!['item/started', 'item/completed', 'turn/completed'].includes(method)) return;
    try {
      if (event.data.hostId && event.data.hostId !== (current()?.hostId || 'local')) return;
      readNativeNotification(event.data); labels?.refresh();
    } catch (error) { reportError(error, 'notification'); }
  };
  const unmount = () => {
    view.removeEventListener('message', receive); labels?.cleanup(); labels = null; main = null; style.remove();
    for (const request of requests.values()) request.reject(new Error('Message labels stopped.'));
    requests.clear(); if (view[key] === endpoint) delete view[key];
  };
  const refresh = () => {
    if (labels && main?.isConnected && main.matches('main.main-surface,main[class*="MainContentSurface"]')
      && !main.closest('[data-app-shell-tab-panel-controller="right"]') && view.location.pathname !== '/detached-window.html') return;
    if (labels) unmount();
    if (view.location.pathname === '/detached-window.html') return;
    main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (!main) return;
    if (view[key]) throw new Error('Message labels already have an owner.');
    view[key] = endpoint; document.head.appendChild(style);
    try {
      labels = installMessageLabels(document, getClient, assistantMessageOrdinals, messageLabelTime, messageOrdinalColor, loadIndex, error => reportError(error, 'labels'));
      view.addEventListener('message', receive);
    } catch (error) { unmount(); throw error; }
  };
  const unsubscribe = onDomChange(refresh);
  try { refresh(); } catch (error) { unsubscribe(); unmount(); throw error; }
  return { close() { unsubscribe(); unmount(); } };
};

export default { manifest, create: createMessageLabels, helpers: { readNativeConversationIdentity, readNativeNotification, findNativeConversationStore,
  installMessageLabels, assistantMessageOrdinals, messageLabelTime, messageOrdinalColor, messageLabelsCss } };
