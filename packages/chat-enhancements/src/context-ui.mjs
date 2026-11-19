export function installContextUi(document, currentThread, helpers, onError) {
  const { readComposerContextUsage, composerHasCharacters, contextUsageBarStyle, updateContextCompactionState } = helpers;
  const view = document.defaultView, compactions = new Map(), owned = new Set();
  let frame = null, stopped = false;
  const clear = surface => {
    surface.classList.remove('codex-context-usage-surface');
    for (const name of ['--cdt-context-usage-width', '--cdt-context-usage-color', '--cdt-context-usage-animation']) surface.style.removeProperty(name);
    owned.delete(surface);
  };
  const render = () => {
    const retained = new Set();
    for (const composer of document.querySelectorAll('[data-codex-composer-root]')) {
      const surface = composer.querySelector('[role="presentation"][data-composer-surface-variant]');
      if (!surface) continue;
      const annotated = composer.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id');
      const panel = composer.closest('[role="tabpanel"][data-tab-id]'), tab = panel?.getAttribute('data-tab-id') || '', separator = tab.indexOf(':');
      const id = (annotated || (panel ? separator > 0 ? tab.slice(separator + 1) : null : currentThread()))?.split(':').at(-1);
      const value = contextUsageBarStyle(readComposerContextUsage(composer), compactions.has(id), composerHasCharacters(composer));
      if (!value) continue;
      retained.add(surface); owned.add(surface);
      if (!surface.classList.contains('codex-context-usage-surface')) surface.classList.add('codex-context-usage-surface');
      for (const [name, content] of [['width', value.width], ['color', value.color], ['animation', value.animation]]) {
        const property = '--cdt-context-usage-' + name;
        if (surface.style.getPropertyValue(property) !== content) surface.style.setProperty(property, content);
      }
    }
    for (const surface of owned) if (!retained.has(surface)) clear(surface);
  };
  const refresh = () => {
    if (stopped || frame !== null) return;
    frame = view.requestAnimationFrame(() => { frame = null; try { render(); } catch (error) { cleanup(); onError(error); } });
  };
  const input = event => { if (event.target.closest?.('[data-codex-composer-root]')) refresh(); };
  const observer = new view.MutationObserver(records => {
    if (records.some(record => (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest('[data-codex-composer-root]'))) refresh();
  });
  observer.observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true, attributeFilter: ['stroke-dashoffset', 'aria-label', 'data-cumberbatch'] });
  document.addEventListener('input', input, true);
  function cleanup() {
    if (stopped) return;
    stopped = true; observer.disconnect(); document.removeEventListener('input', input, true);
    if (frame !== null) view.cancelAnimationFrame(frame);
    for (const surface of owned) clear(surface);
  }
  refresh();
  return { refresh, receive(method, params) { if (updateContextCompactionState(compactions, method, params)) refresh(); }, cleanup };
}
