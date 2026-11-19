import manifest from './kit.json' with { type: 'json' };
import { profilePanelShadowCss } from '../../src/styles.mjs';

export const createProfilePanelShadow = ({ document, onDomChange }, { profilePanelShadowCss }) => {
  const view = document.defaultView, style = document.createElement('style');
  style.setAttribute('data-cdtk-owned', 'profile-panel-shadow'); style.textContent = profilePanelShadowCss();
  let main;
  const refresh = () => {
    if (main && (!main.isConnected || !main.matches('main.main-surface,main[class*="MainContentSurface"]') || main.closest('[data-app-shell-tab-panel-controller="right"]'))) main = null;
    if (view.location.pathname === '/detached-window.html') main = null;
    else if (!main) main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (main && !style.isConnected) document.head.appendChild(style); else if (!main) style.remove();
  };
  const unsubscribe = onDomChange(refresh);
  try { refresh(); } catch (error) { unsubscribe(); style.remove(); throw error; }
  return { close() { unsubscribe(); style.remove(); } };
};

export default { manifest, create: createProfilePanelShadow, helpers: { profilePanelShadowCss } };
