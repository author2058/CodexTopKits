import manifest from './kit.json' with { type: 'json' };
import { fontOverrideCss } from '../../src/styles.mjs';

export const createUiFontSize = ({ document, getRuntimeState, onRuntimeState, onDomChange, reportError }, { fontOverrideCss }) => {
  const view = document.defaultView, className = 'cdtk-kit-ui-font-override', style = document.createElement('style');
  style.setAttribute('data-cdtk-owned', 'ui-font-size');
  let main;
  const refresh = () => {
    if (main && (!main.isConnected || !main.matches('main.main-surface,main[class*="MainContentSurface"]') || main.closest('[data-app-shell-tab-panel-controller="right"]'))) main = null;
    if (view.location.pathname === '/detached-window.html') main = null;
    else if (!main) main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    const size = getRuntimeState()?.themeSettings?.uiFontSizeOverride;
    if (size !== null && (!Number.isInteger(size) || size < 11 || size > 24)) throw new Error('UI font size settings are unavailable or invalid.');
    const active = Boolean(main && size !== null);
    if (active) {
      const css = fontOverrideCss(size, className); if (style.textContent !== css) style.textContent = css;
      if (!style.isConnected) document.head.appendChild(style);
    } else style.remove();
    if (document.documentElement.classList.contains(className) !== active) document.documentElement.classList.toggle(className, active);
  };
  const unsubscribeDom = onDomChange(refresh), unsubscribeState = onRuntimeState(refresh);
  const observer = new view.MutationObserver(records => {
    if (!records.some(record => record.target.matches?.('main,[data-app-shell-tab-panel-controller]'))) return;
    try { refresh(); reportError(null, 'dom'); } catch (error) { reportError(error, 'dom'); }
  });
  observer.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class', 'data-app-shell-tab-panel-controller'] });
  try { refresh(); } catch (error) { unsubscribeDom(); unsubscribeState(); observer.disconnect(); style.remove(); document.documentElement.classList.remove(className); throw error; }
  return { close() { unsubscribeDom(); unsubscribeState(); observer.disconnect(); style.remove(); document.documentElement.classList.remove(className); } };
};

export default { manifest, create: createUiFontSize, helpers: { fontOverrideCss } };
