import manifest from './kit.json' with { type: 'json' };
import { readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import { appendLiveOutput, installLiveOutput } from '../../src/live-output.mjs';
import { liveOutputCss } from '../../src/styles.mjs';

export const createLiveModelOutput = ({ document, dependencies, onDomChange, reportError, i18n }, helpers) => {
  if (typeof i18n?.t !== 'function' || typeof i18n?.onChange !== 'function') throw new Error('live-model-output requires Core 0.3.39 or later.');
  const messages = { en: { title: 'Show or hide the latest 50 lines of model output for this chat', output: 'Latest 50 lines of model output for this chat' },
    'zh-Hans': { title: '点击展开或关闭本线程模型输出（最新50行）', output: '本线程模型输出，最新50行' } };
  const labels = () => ({ title: i18n.t(messages, 'title'), output: i18n.t(messages, 'output') });
  const { readNativeConversationIdentity, readNativeNotification, appendLiveOutput, installLiveOutput, liveOutputCss } = helpers;
  const view = document.defaultView, snapshotKey = '__CODEXTOPKITS_LIVE_OUTPUT_SNAPSHOT__', style = document.createElement('style');
  style.setAttribute('data-cdtk-owned', 'live-model-output'); style.textContent = liveOutputCss();
  let main, output;
  const current = () => readNativeConversationIdentity(document);
  const receive = event => {
    if (event.source && event.source !== view || !['mcp-request', 'mcp-notification'].includes(event.data?.type)) return;
    const method = event.data.type === 'mcp-request' ? event.data.request?.method : event.data.notification?.method ?? event.data.method;
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/plan/delta',
      'item/reasoning/summaryTextDelta', 'item/fileChange/patchUpdated', 'turn/plan/updated', 'item/tool/requestUserInput', 'item/tool/call'].includes(method)) return;
    try {
      if (event.data.hostId && event.data.hostId !== (current()?.hostId || 'local')) return;
      const params = event.data.type === 'mcp-request' ? event.data.request?.params || {} : readNativeNotification(event.data).params;
      output?.receive(method, params);
    } catch (error) { reportError(error, 'notification'); }
  };
  const unmount = () => {
    view.removeEventListener('message', receive); output?.cleanup(); output = null; main = null; style.remove();
  };
  const refresh = () => {
    if (output && main?.isConnected && main.matches('main.main-surface,main[class*="MainContentSurface"]')
      && !main.closest('[data-app-shell-tab-panel-controller="right"]') && view.location.pathname !== '/detached-window.html') return;
    if (output) unmount();
    if (view.location.pathname === '/detached-window.html') return;
    main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (!main) return;
    document.head.appendChild(style);
    try {
      output = installLiveOutput(document, appendLiveOutput, view[snapshotKey], labels);
      view[snapshotKey] = output.snapshot(); view.addEventListener('message', receive);
    } catch (error) { unmount(); throw error; }
  };
  let unsubscribeDom, unsubscribeTimer, unsubscribeLocale;
  try { unsubscribeLocale = i18n.onChange(() => output?.renderText()); unsubscribeDom = onDomChange(refresh);
    unsubscribeTimer = dependencies['composer-timer'].onChange(() => output?.refresh()); refresh(); }
  catch (error) { unsubscribeDom?.(); unsubscribeTimer?.(); unsubscribeLocale?.(); unmount(); throw error; }
  return { close() { unsubscribeDom(); unsubscribeTimer(); unsubscribeLocale(); unmount(); } };
};

export default { manifest, create: createLiveModelOutput, helpers: { readNativeConversationIdentity, readNativeNotification, appendLiveOutput, installLiveOutput, liveOutputCss } };
