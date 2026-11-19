import manifest from './kit.json' with { type: 'json' };
import { installFileLineHighlight } from '../../src/file-line-highlight.mjs';

export const createFileLineHighlight = ({ document, onDomChange }, { installFileLineHighlight }) => {
  let instance;
  const unmount = () => { instance?.cleanup(); instance = null; };
  const refresh = () => {
    const applicable = document.defaultView.location.pathname !== '/detached-window.html'
      && [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (applicable && !instance) instance = installFileLineHighlight(document);
    else if (!applicable && instance) unmount();
  };
  const unsubscribe = onDomChange(refresh);
  try { refresh(); } catch (error) { unsubscribe(); unmount(); throw error; }
  return { close() { unsubscribe(); unmount(); } };
};

export default { manifest, create: createFileLineHighlight, helpers: { installFileLineHighlight } };
