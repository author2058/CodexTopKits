import manifest from './kit.json' with { type: 'json' };
import { readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import { installContextUi } from '../../src/context-ui.mjs';
import { readComposerContextUsage, composerHasCharacters, contextUsageBarStyle, updateContextCompactionState } from '../../src/context-usage.mjs';
import { contextUsageCss, contextUsageTicksCss } from '../../src/styles.mjs';

export const createContextMeter = ({ document, onDomChange, reportError }, helpers) => {
  const { installContextUi, readNativeConversationIdentity, readNativeNotification, contextUsageCss, contextUsageTicksCss } = helpers;
  const view = document.defaultView, style = document.createElement('style');
  style.setAttribute('data-cdtk-owned', 'context-meter');
  style.textContent = contextUsageCss() + contextUsageTicksCss() + '.cdtk-context-meter-hidden .codex-context-usage-surface::after{animation-play-state:paused!important}';
  let meter;
  const current = () => readNativeConversationIdentity(document);
  const visibility = () => {
    if (document.documentElement.classList.contains('cdtk-context-meter-hidden') !== document.hidden) document.documentElement.classList.toggle('cdtk-context-meter-hidden', document.hidden);
  };
  const receive = event => {
    if (event.source && event.source !== view || event.data?.type !== 'mcp-notification') return;
    const method = event.data.notification?.method ?? event.data.method;
    if (!['item/started', 'item/completed', 'turn/completed'].includes(method)) return;
    try {
      const notification = readNativeNotification(event.data), params = notification.params;
      if (method !== 'turn/completed' && params.item?.type !== 'contextCompaction') return;
      if (event.data.hostId && event.data.hostId !== (current()?.hostId || 'local')) return;
      meter?.receive(method, params);
    }
    catch (error) { reportError(error, 'notification'); }
  };
  const unmount = () => {
    if (!meter) return;
    view.removeEventListener('message', receive); document.removeEventListener('visibilitychange', visibility);
    meter.cleanup(); meter = null; style.remove(); document.documentElement.classList.remove('cdtk-context-meter-hidden');
  };
  const refresh = () => {
    const applicable = view.location.pathname !== '/detached-window.html'
      && [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (applicable && !meter) {
      document.head.appendChild(style);
      try {
        meter = installContextUi(document, () => current()?.taskKey || null, helpers, error => reportError(error, 'context'));
        view.addEventListener('message', receive); document.addEventListener('visibilitychange', visibility); visibility();
      } catch (error) { unmount(); style.remove(); throw error; }
    } else if (!applicable) unmount();
  };
  const unsubscribe = onDomChange(refresh);
  try { refresh(); } catch (error) { unsubscribe(); unmount(); throw error; }
  return { close() { unsubscribe(); unmount(); } };
};

export default { manifest, create: createContextMeter, helpers: { installContextUi, readNativeConversationIdentity, readNativeNotification,
  readComposerContextUsage, composerHasCharacters, contextUsageBarStyle, updateContextCompactionState, contextUsageCss, contextUsageTicksCss } };
