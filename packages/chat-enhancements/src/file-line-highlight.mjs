export function installFileLineHighlight(document) {
  const normalizePath = (path) => path.replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:\/)/, '').toLowerCase();
  const controllers = new Map();
  const overlays = new Map();
  let pending = null;
  let disposed = false;
  let last = null;

  const matchingRequest = (controller, line) => pending && pending.line === line
    && normalizePath(controller.filePath) === normalizePath(pending.path);
  const show = (controller, line) => {
    if (!matchingRequest(controller, line)) return;
    const view = controller.editorView;
    if (!view || typeof view.requestMeasure !== 'function' || typeof view.lineBlockAt !== 'function') return;
    const request = pending;
    pending = null;
    view.requestMeasure({
      read() {
        if (disposed || view.destroyed || !view.dom.isConnected) return null;
        const number = Math.min(Math.max(line, 1), view.state.doc.lines);
        const block = view.lineBlockAt(view.state.doc.line(number).from);
        const contentRect = view.contentDOM.getBoundingClientRect();
        const scrollerRect = view.scrollDOM.getBoundingClientRect();
        const scaleY = view.scaleY || 1;
        return {
          left: Math.max(contentRect.left, scrollerRect.left) + 2,
          right: Math.min(contentRect.right, scrollerRect.right) - 2,
          top: view.documentTop + block.top * scaleY,
          height: block.height * scaleY,
          clipTop: scrollerRect.top,
          clipBottom: scrollerRect.bottom,
          number,
        };
      },
      write(rect) {
        if (!rect || disposed || rect.right <= rect.left || rect.height <= 0) return;
        // The clipping layer stays within the editor viewport; the line frame
        // covers the entire wrapped line without taking any layout space.
        const clip = document.createElement('div');
        clip.className = 'codex-file-line-highlight-clip';
        clip.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;z-index:30;left:'
          + (rect.left - 7) + 'px;top:' + rect.clipTop + 'px;width:' + (rect.right - rect.left + 14)
          + 'px;height:' + (rect.clipBottom - rect.clipTop) + 'px';
        const frame = document.createElement('div');
        frame.className = 'codex-file-line-highlight';
        frame.style.cssText = 'position:absolute;pointer-events:none;box-sizing:border-box;left:7px;top:'
          + (rect.top - rect.clipTop) + 'px;width:' + (rect.right - rect.left) + 'px;height:'
          + rect.height + 'px;border:2px solid #2389ff;box-shadow:0 0 5px #2389ff;border-radius:3px';
        clip.append(frame);
        document.body.append(clip);
        overlays.set(clip, { frame, view, rect });
        last = { path: request.path, line: rect.number, at: new Date().toISOString(), height: rect.height };
        const animation = frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000, easing: 'linear', fill: 'forwards' });
        const remove = () => { clip.remove(); overlays.delete(clip); };
        animation.onfinish = remove;
        animation.oncancel = remove;
      },
    });
  };
  const refresh = () => {
    if (disposed) return;
    for (const [controller, entry] of controllers) {
      if (controller.isDisposed || !entry.host.isConnected) {
        if (controller.onLineRevealHandled === entry.wrapper) controller.onLineRevealHandled = entry.original;
        controllers.delete(controller);
      }
    }
    for (const editor of document.querySelectorAll('[role="tabpanel"][data-app-shell-tab-panel-controller="right"] .cm-editor')) {
      let host = editor;
      while (host && !Object.keys(host).some((key) => key.startsWith('__reactFiber'))) host = host.parentElement;
      let fiber = host?.[Object.keys(host).find((key) => key.startsWith('__reactFiber'))];
      for (; fiber; fiber = fiber.return) {
        for (let hook = fiber.memoizedState; hook; hook = hook.next) {
          const controller = hook.memoizedState?.current;
          if (typeof controller?.revealLine !== 'function' || typeof controller.onLineRevealHandled !== 'function'
            || typeof controller.filePath !== 'string') continue;
          if (!controllers.has(controller)) {
            const original = controller.onLineRevealHandled;
            const wrapper = function (line) {
              const result = original.apply(this, arguments);
              show(controller, line);
              return result;
            };
            controller.onLineRevealHandled = wrapper;
            controllers.set(controller, { original, wrapper, host: editor });
          }
          // Initial reveal can precede the DOM observer attaching this callback.
          if (pending && matchingRequest(controller, pending.line) && controller.editorView && controller.lineToReveal == null) {
            show(controller, pending.line);
          }
        }
      }
    }
  };
  const click = (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const reference = event.target?.closest?.('[data-file-reference="true"]');
    if (!reference?.closest('.thread-scroll-container')) return;
    pending = null;
    const href = reference.getAttribute('data-prompt-link-href') || '';
    const match = href.match(/^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?)(?:[-:].*)?$/);
    if (!match) return;
    const line = Number(match[2] || match[3]);
    if (!Number.isInteger(line) || line < 1) return;
    pending = { path: match[1], line };
    // Attach to an already-open editor before its native click handler runs.
    // Do not consume the request until the original reveal has occurred.
    const request = pending;
    pending = null;
    refresh();
    pending = request;
  };
  const clearOverlays = () => { for (const clip of overlays.keys()) clip.remove(); overlays.clear(); };
  const trackScroll = (event) => {
    for (const { frame, view, rect } of overlays.values()) {
      if (event.target === view.scrollDOM) {
        const block = view.lineBlockAt(view.state.doc.line(rect.number).from);
        frame.style.top = (view.documentTop + block.top * (view.scaleY || 1) - rect.clipTop) + 'px';
      }
    }
  };
  document.addEventListener('click', click, true);
  document.addEventListener('scroll', trackScroll, true);
  document.defaultView.addEventListener('resize', clearOverlays);
  refresh();
  return {
    refresh,
    status: () => ({
      installed: !disposed,
      hookedEditors: controllers.size,
      editorCount: document.querySelectorAll('[role="tabpanel"][data-app-shell-tab-panel-controller="right"] .cm-editor').length,
      nativeReady: [...controllers.keys()].every((controller) => !controller.editorView
        || typeof controller.editorView.requestMeasure === 'function' && typeof controller.editorView.lineBlockAt === 'function'),
      pending, last,
    }),
    cleanup() {
      disposed = true;
      document.removeEventListener('click', click, true);
      document.removeEventListener('scroll', trackScroll, true);
      document.defaultView.removeEventListener('resize', clearOverlays);
      for (const [controller, entry] of controllers) {
        if (controller.onLineRevealHandled === entry.wrapper) controller.onLineRevealHandled = entry.original;
      }
      controllers.clear();
      clearOverlays();
    },
  };
}
