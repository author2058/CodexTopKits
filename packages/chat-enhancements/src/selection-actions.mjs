export function installSelectionActions(document) {
  const view = document.defaultView, overlays = new Set();
  let delay = null, interactive = null, stopped = false;
  const selected = () => { const selection = document.getSelection(); return Boolean(selection && !selection.isCollapsed && selection.toString().trim()); };
  const cancel = () => { view.clearTimeout(delay); view.clearTimeout(interactive); delay = interactive = null; };
  const refresh = () => {
    if (stopped || !selected()) return;
    const button = [...document.querySelectorAll('button')].find(node => /^add\s+to\s+chat(?:\s|$)/i.test(node.textContent?.replace(/\s+/g, ' ').trim() || ''));
    const overlay = button?.closest('div.pointer-events-none.fixed.z-50');
    if (!overlay || overlay.dataset.codexSelectionDelay === 'armed') return;
    overlays.add(overlay); overlay.dataset.codexSelectionDelay = 'armed';
    overlay.classList.add('codex-selection-actions-delayed'); overlay.classList.remove('codex-selection-actions-ready', 'codex-selection-actions-interactive');
    cancel();
    delay = view.setTimeout(() => {
      delay = null; if (!overlay.isConnected || !selected()) return;
      overlay.classList.add('codex-selection-actions-ready');
      interactive = view.setTimeout(() => { interactive = null; if (overlay.isConnected && selected()) overlay.classList.add('codex-selection-actions-interactive'); }, 500);
    }, 1000);
  };
  const change = () => {
    cancel();
    for (const overlay of overlays) { overlay.classList.remove('codex-selection-actions-ready', 'codex-selection-actions-interactive'); delete overlay.dataset.codexSelectionDelay; if (!overlay.isConnected) overlays.delete(overlay); }
    view.queueMicrotask(refresh);
  };
  const observer = new view.MutationObserver(records => { if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && (node.matches('button,div.fixed') || node.querySelector('button'))))) refresh(); });
  observer.observe(document.body, { childList: true, subtree: true }); document.addEventListener('selectionchange', change); refresh();
  return { refresh, cleanup() { stopped = true; cancel(); observer.disconnect(); document.removeEventListener('selectionchange', change); for (const overlay of overlays) { overlay.classList.remove('codex-selection-actions-delayed', 'codex-selection-actions-ready', 'codex-selection-actions-interactive'); delete overlay.dataset.codexSelectionDelay; } } };
}
