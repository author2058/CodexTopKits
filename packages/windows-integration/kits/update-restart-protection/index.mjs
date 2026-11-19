import manifest from './kit.json' with { type: 'json' };
import { createNativeAssetReader, loadNativeAppServices } from 'codex-toolkit-core/renderer';
import { installHostedUpdateControl, updateIndicatorCss } from '../../src/update-indicator.mjs';

export const createUpdateRestartProtection = ({ document, onDomChange, dispatch, reportError, sharedCdpPort }, helpers) => {
  if (sharedCdpPort !== true) throw new Error('Update protection requires Core 0.3.19 or later.');
  const { createNativeAssetReader, loadNativeAppServices, installHostedUpdateControl, updateIndicatorCss } = helpers;
  const view = document.defaultView, legacy = view.__CODEX_DESKTOP_TOOLKIT_WINDOWS__, key = '__CODEXTOPKITS_RESTART_PROTECTION__';
  if (legacy && !legacy.handoffs?.updateProtection) throw new Error('The existing Windows module has not handed off update protection.');
  const style = document.createElement('style'), requests = new Map(); style.setAttribute('data-cdtk-owned', 'update-restart-protection'); style.textContent = updateIndicatorCss();
  let main, control, observer, services, loading = false, stopped = false;
  const endpoint = { resolve(id, result, error) {
    const request = requests.get(id); if (!request) return false;
    requests.delete(id); error ? request.reject(Object.assign(new Error(error.message), error)) : request.resolve(result); return true;
  } };
  const register = () => new Promise((resolve, reject) => {
    const requestId = view.crypto.randomUUID(); requests.set(requestId, { resolve, reject });
    try { dispatch({ kind: 'restart-protection', requestId }); } catch (error) { requests.delete(requestId); reject(error); }
  });
  const startControl = () => {
    if (stopped || !main || control || !services) return;
    if (typeof services.appUpdates?.installUpdate !== 'function') throw new Error('Codex 原生更新接口不可用。');
    control = installHostedUpdateControl(view, { services }, { registerRestart: register, onStatus() {}, onError: error => reportError(error, 'protection') });
    const installed = control;
    void installed.ready.then(() => { if (!stopped && control === installed) reportError(null, 'protection'); }).catch(() => { /* The control reports the original failure. */ });
  };
  const loadNative = () => {
    if (loading) return; loading = true;
    void loadNativeAppServices(document, { assets: createNativeAssetReader(document) }).then(value => {
      if (!stopped) { services = value; startControl(); reportError(null, 'native'); }
    }).catch(error => { if (!stopped) reportError(error, 'native'); });
  };
  const unmount = () => {
    observer?.disconnect(); observer = null; control?.cleanup(); control = null; main = null; style.remove();
    for (const request of requests.values()) request.reject(new Error('Update protection Kit stopped.'));
    requests.clear(); if (view[key] === endpoint) delete view[key];
  };
  const refresh = () => {
    if (main?.isConnected && main.matches('main.main-surface,main[class*="MainContentSurface"]')
      && !main.closest('[data-app-shell-tab-panel-controller="right"]') && view.location.pathname !== '/detached-window.html') return;
    if (main) unmount();
    if (view.location.pathname === '/detached-window.html') return;
    main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (!main) return;
    if (view[key]) throw new Error('Update protection already has an owner.');
    view[key] = endpoint; document.head.appendChild(style);
    try {
      const watch = 'main,button';
      observer = new view.MutationObserver(records => {
        if (records.some(record => record.type === 'attributes' ? record.target.matches?.(watch)
          : [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches?.(watch) || node.querySelector?.(watch))))) { refresh(); control?.refreshButtons(); }
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'disabled'] });
      if (services) startControl(); else loadNative();
    } catch (error) { unmount(); throw error; }
  };
  const unsubscribe = onDomChange(refresh);
  try { refresh(); } catch (error) { unsubscribe(); unmount(); throw error; }
  return { close() { stopped = true; unsubscribe(); unmount(); } };
};

export default { manifest, create: createUpdateRestartProtection, helpers: { createNativeAssetReader, loadNativeAppServices, installHostedUpdateControl, updateIndicatorCss } };
