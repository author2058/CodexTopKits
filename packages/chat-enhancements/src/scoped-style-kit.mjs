export function installScopedStyleKit({ document, onDomChange }, id, css, start) {
  const style = document.createElement('style');
  style.setAttribute('data-cdtk-owned', id); style.textContent = css;
  let instance;
  const unmount = () => { instance?.cleanup(); instance = null; style.remove(); };
  const refresh = () => {
    const applicable = document.defaultView.location.pathname !== '/detached-window.html'
      && [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
    if (applicable) {
      if (style.parentElement !== document.head) {
        document.head.appendChild(style);
        try { if (!instance) instance = start?.(document); } catch (error) { style.remove(); throw error; }
      }
    } else unmount();
  };
  const unsubscribe = onDomChange(refresh);
  try { refresh(); } catch (error) { unsubscribe(); unmount(); throw error; }
  return { close() { unsubscribe(); unmount(); } };
}
