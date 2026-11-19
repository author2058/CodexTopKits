import manifest from './kit.json' with { type: 'json' };
import { createNativeBridgeClient, readNativeNotification } from 'codex-toolkit-core/renderer';
import { normalizeRuntimeSettings, sameRuntimeSettings, createRuntimeGuard } from '../../src/runtime-settings.mjs';

export const createAgentModelProtection = ({ document, onDomChange, reportError, restartPreflight, i18n }, helpers) => {
  const messages = { en: { busy: 'The child-agent model settings are being checked. Retry after the check finishes.' }, 'zh-Hans': { busy: '子代理模型配置正在校验，请完成后再重试。' } };
  if (restartPreflight !== true) throw new Error('Agent model protection requires Core 0.3.18 or later.');
  const view = document.defaultView, key = '__CODEXTOPKITS_AGENT_MODEL_PROTECTION__';
  if (view[key]) throw new Error('Agent model protection already has an owner.');
  let guard, bridge, observer, stopped = false, scheduled = false;
  const applicable = () => view.location.pathname !== '/detached-window.html'
    && [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(node => !node.closest('[data-app-shell-tab-panel-controller="right"]'));
  const refresh = () => {
    if (stopped || !applicable()) return;
    const session = view.__CODEX_DESKTOP_TOOLKIT_SESSION__;
    if (!session) return;
    if (!session.handoffs?.modelProtection) throw new Error('Session Recovery has not handed off model protection.');
    if (typeof session.getRegistry !== 'function') return;
    if (!guard) {
      bridge = helpers.createNativeBridgeClient(view);
      guard = helpers.createRuntimeGuard((method, params, source) => bridge.appServer(method, params, { source }), session.getRegistry(),
        status => { const current = view.__CODEX_DESKTOP_TOOLKIT_SESSION__; if (current?.handoffs?.modelProtection) current.reportRuntimeStatus(status); }, helpers.normalizeRuntimeSettings, helpers.sameRuntimeSettings);
    } else guard.update(session.getRegistry());
    const ids = new Set([...document.querySelectorAll('[data-above-composer-conversation-id]')].filter(node => (node.closest('[data-codex-composer-root]') || node.parentElement)?.getClientRects().length).map(node => node.getAttribute('data-above-composer-conversation-id')?.replace(/^local:/, '')));
    for (const panel of document.querySelectorAll('[role="tabpanel"][data-tab-id^="background-agent:"],[role="tabpanel"][data-tab-id^="sidechat:"]')) if (panel.getClientRects().length) ids.add(panel.getAttribute('data-tab-id').split(':').at(-1));
    for (const id of ids) if (id) void guard.ensure(id).catch(() => { /* The guard reports the original failure. */ });
    reportError(null, 'runtime');
  };
  const schedule = () => {
    if (!scheduled && !stopped) { scheduled = true; view.queueMicrotask(() => { scheduled = false; try { refresh(); } catch (error) { reportError(error, 'runtime'); } }); }
  };
  const receive = event => {
    if (!guard || event.source && event.source !== view || event.data?.type !== 'mcp-notification' || event.data.hostId && event.data.hostId !== 'local') return;
    try { const { method, params } = helpers.readNativeNotification(event.data); guard.receive(method, params); reportError(null, 'runtime-event'); } catch (error) { reportError(error, 'runtime-event'); }
  };
  const watch = 'main,[class*="_Workspace_"],[data-above-composer-conversation-id],[role="tabpanel"][data-tab-id]';
  observer = new view.MutationObserver(records => { if (records.some(record => record.target.matches?.(watch))) schedule(); });
  observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-above-composer-conversation-id', 'data-tab-id', 'hidden', 'aria-hidden', 'class', 'style'] });
  const unsubscribe = onDomChange(schedule), check = () => { if (guard?.busy()) throw new Error(i18n?.t(messages, 'busy') ?? messages['zh-Hans'].busy); };
  const api = view[key] = { supportsProtectionRelease: true, ensure: (...args) => guard ? guard.ensure(...args) : Promise.reject(new Error('Agent model protection is not ready.')),
    update: value => guard?.update(value), status: () => guard?.status() || [] };
  view.addEventListener('message', receive); view.addEventListener('codextopkits-session-ready', schedule);
  try { refresh(); } catch (error) { stopped = true; unsubscribe(); observer.disconnect(); bridge?.close(); view.removeEventListener('message', receive); view.removeEventListener('codextopkits-session-ready', schedule); delete view[key]; throw error; }
  return { beforeRestart: check, close() { check(); stopped = true; unsubscribe(); observer.disconnect(); guard?.cleanup(); bridge?.close(); view.removeEventListener('message', receive); view.removeEventListener('codextopkits-session-ready', schedule); if (view[key] === api) delete view[key]; } };
};

export default { manifest, create: createAgentModelProtection, helpers: { createNativeBridgeClient, readNativeNotification, normalizeRuntimeSettings, sameRuntimeSettings, createRuntimeGuard } };
