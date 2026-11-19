import manifest from './kit.json' with { type: 'json' };
import { readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import { installSpeedUi } from '../../src/speed-ui.mjs';
import { createOutputSpeedTracker, numericTokenField, lastOutputTokenCount, calculateOutputSpeed, applyOutputSpeedMeasurement } from '../../src/output-speed.mjs';
import { speedHistoryCss } from '../../src/styles.mjs';

export const createOutputSpeed = ({ document, onDomChange, reportError, i18n }, helpers) => {
  if (typeof i18n?.t !== 'function' || typeof i18n?.onChange !== 'function') throw new Error('output-speed requires Core 0.3.39 or later.');
  const messages = { en: { generation: 'Generation', endToEnd: 'End-to-end', first: 'First response', title: 'Generation speed uses the native output token count and the time between the first and last model content of the response. End-to-end speed also includes request wait time.' },
    'zh-Hans': { generation: '生成', endToEnd: '端到端', first: '首响', title: '生成速度：对应响应的原生输出 token 数与首末模型内容的时间；端到端速度另计请求等待时间。' } };
  const labels = () => Object.fromEntries(['generation', 'endToEnd', 'first', 'title'].map(key => [key, i18n.t(messages, key)]));
  const { readNativeConversationIdentity, readNativeNotification, installSpeedUi, createOutputSpeedTracker, speedHistoryCss } = helpers;
  const view = document.defaultView, snapshotKey = '__CODEXTOPKITS_OUTPUT_SPEED_SNAPSHOT__', style = document.createElement('style');
  style.setAttribute('data-cdtk-owned', 'output-speed'); style.textContent = speedHistoryCss('.codex-output-token-speed');
  let main, speed, tracker, observer;
  const current = () => readNativeConversationIdentity(document);
  const receive = event => {
    if (event.source && event.source !== view || event.data?.type !== 'mcp-notification') return;
    const method = event.data.notification?.method ?? event.data.method;
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated',
      'item/agentMessage/delta', 'item/plan/delta', 'item/transcript/delta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded'].includes(method)) return;
    try {
      const notification = readNativeNotification(event.data);
      if (event.data.hostId && event.data.hostId !== (current()?.hostId || 'local')) return;
      tracker?.receive(notification.method, notification.params);
    } catch (error) { reportError(error, 'notification'); }
  };
  const unmount = () => {
    observer?.disconnect(); observer = null; view.removeEventListener('message', receive);
    speed?.cleanup(); speed = null; tracker = null; main = null; style.remove();
  };
  const watch = 'main,[class*="_Workspace_"],[data-codex-composer-root],[data-app-action-timeline-scroll],.thread-scroll-container,[role="tabpanel"][data-tab-id],[data-above-composer-conversation-id]';
  const owned = node => node?.nodeType === 1 && (node.hasAttribute('data-cdtk-owned') || node.closest('[data-cdtk-owned],[data-cdtk-chat-owned]'));
  const changed = records => records.some(record => {
    if (owned(record.target)) return false;
    if (record.type === 'attributes') return record.target.matches?.(watch);
    return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && !owned(node) && (node.matches?.(watch) || node.querySelector?.(watch)));
  });
  const refresh = () => {
    if (speed && main?.isConnected && main.matches('main.main-surface,main[class*="MainContentSurface"]')
      && !main.closest('[data-app-shell-tab-panel-controller="right"]') && view.location.pathname !== '/detached-window.html') return;
    if (speed) unmount();
    if (view.location.pathname === '/detached-window.html') return;
    main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (!main) return;
    document.head.appendChild(style);
    try {
      tracker = createOutputSpeedTracker(() => speed?.update(), view[snapshotKey]);
      view[snapshotKey] = tracker.snapshot();
      speed = installSpeedUi(document, tracker, () => current()?.taskKey || null, error => reportError(error, 'speed'), undefined, labels);
      view.addEventListener('message', receive);
      observer = new view.MutationObserver(records => { if (changed(records)) { refresh(); speed?.refresh(); } });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state', 'data-tab-id', 'data-above-composer-conversation-id'] });
    } catch (error) { unmount(); throw error; }
  };
  let unsubscribe, unsubscribeLocale;
  try { unsubscribeLocale = i18n.onChange(() => speed?.renderText()); unsubscribe = onDomChange(refresh); refresh(); }
  catch (error) { unsubscribe?.(); unsubscribeLocale?.(); unmount(); throw error; }
  return { close() { unsubscribe(); unsubscribeLocale(); unmount(); } };
};

export default { manifest, create: createOutputSpeed, helpers: { readNativeConversationIdentity, readNativeNotification, installSpeedUi,
  createOutputSpeedTracker, numericTokenField, lastOutputTokenCount, calculateOutputSpeed, applyOutputSpeedMeasurement, speedHistoryCss } };
