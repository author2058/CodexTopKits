import manifest from './kit.json' with { type: 'json' };
import { installReadAloudMenu } from '../../src/read-aloud-menu.mjs';

export const createMarkdownReadAloud = ({ document, onDomChange, dispatch, reportError, i18n }, { installReadAloudMenu }) => {
  if (!i18n) throw new Error('Markdown read aloud requires Core 0.3.39 or later.');
  const messages = { en: { label: 'Open and read aloud with Microsoft Edge' }, 'zh-Hans': { label: '用 Microsoft Edge 打开并朗读' } };
  const view = document.defaultView, legacy = view.__CODEX_DESKTOP_TOOLKIT_WINDOWS__;
  if (legacy && !legacy.handoffs?.readAloud) throw new Error('The existing Windows module has not handed off Markdown read aloud.');
  let main, menu, observer;
  const unmount = () => { observer?.disconnect(); observer = null; menu?.cleanup(); menu = null; main = null; };
  const updateMenu = () => {
    if (!menu) return;
    try { menu.refresh(); reportError(null, 'menu'); } catch (error) { reportError(error, 'menu'); }
  };
  const refresh = () => {
    if (menu && main?.isConnected && main.matches('main.main-surface,main[class*="MainContentSurface"]')
      && !main.closest('[data-app-shell-tab-panel-controller="right"]') && view.location.pathname !== '/detached-window.html') return;
    if (menu) unmount();
    if (view.location.pathname === '/detached-window.html') return;
    main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (!main) return;
    try {
      menu = installReadAloudMenu(document, value => dispatch(value), error => reportError(error, 'menu'), () => i18n.t(messages, 'label'));
      const watch = 'main,file-tree-container,button';
      observer = new view.MutationObserver(records => {
        if (records.some(record => record.type === 'attributes' ? record.target.matches?.(watch)
          : [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches?.(watch) || node.querySelector?.(watch))))) { refresh(); updateMenu(); }
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'disabled'] });
      updateMenu();
    } catch (error) { unmount(); throw error; }
  };
  const unsubscribe = onDomChange(refresh);
  try { refresh(); } catch (error) { unsubscribe(); unmount(); throw error; }
  return { close() { unsubscribe(); unmount(); } };
};

export default { manifest, create: createMarkdownReadAloud, helpers: { installReadAloudMenu } };
