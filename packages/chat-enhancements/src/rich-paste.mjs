export function sanitizeRichPaste(document, html, plain, hasFiles = false) {
  const result = { changed: false, html, reason: 'missing-text-format', removedLeading: 0, removedTrailing: 0 };
  if (hasFiles) return { ...result, reason: 'files-present' };
  if (!plain || !html?.trim()) return result;
  if (/^\s|\s$/u.test(plain)) return { ...result, reason: 'plain-has-boundary-whitespace' };
  const parsed = new document.defaultView.DOMParser().parseFromString(html, 'text/html');
  for (const element of parsed.body.querySelectorAll('script,style,template,noscript,[hidden],[aria-hidden="true"]')) element.remove();
  for (const element of parsed.body.querySelectorAll('[style]')) if (element.style.display === 'none' || element.style.visibility === 'hidden') element.remove();
  const before = parsed.body.textContent || '', normalize = value => value.replace(/\s+/gu, ' ').trim();
  if (!/^\s|\s$/u.test(before)) return { ...result, reason: 'html-boundary-clean' };
  if (normalize(before) !== normalize(plain)) return { ...result, reason: 'content-mismatch' };
  const walker = parsed.createTreeWalker(parsed.body, document.defaultView.NodeFilter.SHOW_TEXT), nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  for (const node of nodes) { node.data = node.data.replace(/^\s+/u, ''); if (node.data) break; }
  for (let i = nodes.length - 1; i >= 0; i--) { nodes[i].data = nodes[i].data.replace(/\s+$/u, ''); if (nodes[i].data) break; }
  const after = parsed.body.textContent || '';
  if (/^\s|\s$/u.test(after) || normalize(after) !== normalize(plain)) return { ...result, reason: 'boundary-retained' };
  return { changed: before !== after, html: parsed.body.innerHTML, reason: 'ready', removedLeading: before.match(/^\s*/u)[0].length, removedTrailing: before.match(/\s*$/u)[0].length };
}

export function installRichPaste(document, sanitize, onDiagnostic, onError) {
  const paste = event => {
    const composer = event.target?.closest?.('[data-codex-composer][contenteditable="true"],.ProseMirror[data-composer-markdown][contenteditable="true"]');
    if (!composer || !event.clipboardData) return;
    try {
      const data = event.clipboardData, html = data.getData('text/html'), plain = data.getData('text/plain');
      const result = sanitize(document, html, plain, data.files.length > 0 || [...(data.items || [])].some(item => item.kind === 'file'));
      if (result.changed) {
        const original = data.getData.bind(data);
        Object.defineProperty(data, 'getData', { configurable: true, value: type => typeof type === 'string' && type.toLowerCase() === 'text/html' ? result.html : original(type) });
      }
      onDiagnostic({ reason: result.reason, applied: result.changed, plainLength: plain.length, htmlLength: html.length, removedLeading: result.removedLeading, removedTrailing: result.removedTrailing });
    } catch (error) { onError(error); }
  };
  document.addEventListener('paste', paste, true);
  return { cleanup() { document.removeEventListener('paste', paste, true); } };
}
