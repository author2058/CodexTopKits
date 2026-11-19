import manifest from './kit.json' with { type: 'json' };
import { createNativeAssetReader, createNativeBridgeClient, readNativeConversationIdentity } from 'codex-toolkit-core/renderer';
import { installAgentComposerRestore } from '../../src/agent-composer.mjs';

export const createAgentComposer = ({ document, onDomChange, reportError, restartPreflight, i18n }, helpers) => {
  const messages = { en: { busy: 'The child-agent composer is being restored. Restart the Kit host after restoration finishes.' }, 'zh-Hans': { busy: '子代理输入框正在恢复，请稍后再重启 Kit 宿主。' } };
  if (restartPreflight !== true) throw new Error('Agent composer requires Core 0.3.18 or later.');
  const view = document.defaultView, key = '__CODEXTOPKITS_AGENT_COMPOSER__', legacy = view.__CODEX_DESKTOP_TOOLKIT_SESSION__;
  if (view.__CODEX_DYNAMIC_THEME__) throw new Error('Stop the old controller before enabling the agent composer Kit.');
  if (legacy && !legacy.handoffs?.agentComposer) throw new Error('The Session module has not handed off the agent composer.');
  if (view[key]) throw new Error('The agent composer already has an owner.');
  let restorer, bridge, observer, scheduled = false, stopped = false;
  const applicable = () => view.location.pathname !== '/detached-window.html'
    && [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(node => !node.closest('[data-app-shell-tab-panel-controller="right"]') && node.querySelector('[data-codex-composer-root]'));
  const status = () => {
    const state = restorer?.status();
    if (state?.compatibility?.ok && (!state.last || state.last.ok)) reportError(null, 'agent-composer');
  };
  const refresh = () => {
    if (stopped || !applicable()) return;
    if (!restorer) {
      bridge = helpers.createNativeBridgeClient(view);
      restorer = helpers.installAgentComposerRestore(document, bridge, helpers.createNativeAssetReader(document), error => reportError(error, 'agent-composer'), status, helpers.readNativeConversationIdentity);
    }
    restorer.refresh();
  };
  const schedule = () => {
    if (!scheduled && !stopped) { scheduled = true; view.queueMicrotask(() => { scheduled = false; try { refresh(); } catch (error) { reportError(error, 'agent-composer'); } }); }
  };
  const watch = 'main,[class*="_Workspace_"],[data-above-composer-conversation-id],[role="tabpanel"][data-tab-id]';
  observer = new view.MutationObserver(records => { if (records.some(record => record.target.matches?.(watch))) schedule(); });
  observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-above-composer-conversation-id', 'data-tab-id', 'hidden', 'aria-hidden', 'class', 'style'] });
  const unsubscribe = onDomChange(schedule);
  const check = () => { if (restorer?.status().active) throw new Error(i18n?.t(messages, 'busy') ?? messages['zh-Hans'].busy); };
  view[key] = true;
  try { refresh(); } catch (error) { stopped = true; unsubscribe(); observer.disconnect(); bridge?.close(); delete view[key]; throw error; }
  return { status: () => restorer?.status() || null, beforeRestart: check, close() { check(); stopped = true; unsubscribe(); observer.disconnect(); restorer?.cleanup(); bridge?.close(); delete view[key]; } };
};

export default { manifest, create: createAgentComposer, helpers: { createNativeAssetReader, createNativeBridgeClient, readNativeConversationIdentity, installAgentComposerRestore } };
