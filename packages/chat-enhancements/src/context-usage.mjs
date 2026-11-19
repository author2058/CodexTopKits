// Serialized into the renderer; reuse the native donut's exact percentage.
export function readComposerContextUsage(composer) {
  const ring = composer.querySelector('[role="img"][aria-label] circle[pathLength="100"][stroke-dashoffset]');
  if (!ring) return null;
  const raw = ring.getAttribute('stroke-dashoffset');
  if (raw === null || raw.trim() === '') return null;
  const offset = Number(raw);
  return Number.isFinite(offset) ? Math.max(0, Math.min(100, 100 - offset)) : null;
}

export function composerHasCharacters(composer) {
  const editor = composer.querySelector('[contenteditable="true"][role="textbox"],textarea');
  if (!editor) return false;
  if (typeof editor.value === 'string') return editor.value.length > 0;
  // Native next-message predictions are decorations, not authored editor text.
  const hasText = (node) => {
    if (node.nodeType === 3) return Boolean(node.textContent?.length);
    if (node.nodeType === 1 && node.hasAttribute('data-cumberbatch')) return false;
    for (const child of node.childNodes) if (hasText(child)) return true;
    return false;
  };
  return hasText(editor);
}

export function contextUsageBarStyle(percent, compacting = false, hasCharacters = false) {
  if (!Number.isFinite(percent)) return null;
  const value = Math.max(0, Math.min(100, percent));
  const alert = value > 83.33333;
  return { percent: value, width: value + '%', color: compacting ? '#9ca3af' : alert ? '#ef4444' : value > 75 ? '#f97316' : value > 60 ? '#eab308' : '#22c55e', animation: alert && !compacting ? 'cdt-context-usage-pulse ' + (hasCharacters ? '250ms' : '2000ms') + ' ease-in-out infinite' : 'none' };
}

// Serialized into the renderer; native item lifecycle is scoped by thread and turn.
export function updateContextCompactionState(active, method, params) {
  const threadId = params?.threadId?.replace(/^[^:]+:/, '');
  if (!threadId) return false;
  const previous = active.get(threadId);
  if (method === 'item/started' && params.item?.type === 'contextCompaction') {
    active.set(threadId, { turnId: params.turnId, itemId: params.item.id });
    return true;
  }
  if (!previous) return false;
  if (method === 'item/completed' && params.item?.type === 'contextCompaction'
      && params.turnId === previous.turnId && params.item.id === previous.itemId) return active.delete(threadId);
  if (method === 'turn/completed' && (params.turnId || params.turn?.id) === previous.turnId) return active.delete(threadId);
  return false;
}
