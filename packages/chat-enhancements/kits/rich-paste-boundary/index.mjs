import manifest from './kit.json' with { type: 'json' };
import { sanitizeRichPaste, installRichPaste } from '../../src/rich-paste.mjs';

export const createRichPasteBoundary = ({ document, onDomChange, dispatch, reportError }, { sanitizeRichPaste, installRichPaste }) => {
  let instance;
  const unmount = () => { instance?.cleanup(); instance = null; };
  const refresh = () => {
    const applicable = document.defaultView.location.pathname !== '/detached-window.html'
      && [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (applicable && !instance) instance = installRichPaste(document, sanitizeRichPaste,
      record => dispatch({ kind: 'chat-diagnostic', feature: 'paste', record }), error => reportError(error, 'paste'));
    else if (!applicable && instance) unmount();
  };
  const unsubscribe = onDomChange(refresh);
  try { refresh(); } catch (error) { unsubscribe(); unmount(); throw error; }
  return { close() { unsubscribe(); unmount(); } };
};

export default { manifest, create: createRichPasteBoundary, helpers: { sanitizeRichPaste, installRichPaste } };
