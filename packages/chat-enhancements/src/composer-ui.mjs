export function installComposerUi(document, options, helpers) {
  const { getClient, getRpc, currentThread, getFormatter, getLocale, onError, onDiagnostic, changed } = options;
  const { nativeComposerTiming, createRpcComposerTiming, nativeWorkedTiming, composerIsWorking } = helpers;
  const view = document.defaultView, hosts = new Map();
  const lifecycle = new Set(['turn/started', 'turn/completed', 'thread/status/changed', 'item/started', 'item/completed']);
  let stopped = false, frame = null, interval = null;
  const set = (element, name, value) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
  const identity = composer => {
    const annotated = composer.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id');
    const panel = composer.closest('[role="tabpanel"][data-tab-id]');
    const tab = panel?.getAttribute('data-tab-id') || '', separator = tab.indexOf(':');
    return (annotated || (panel ? separator > 0 ? tab.slice(separator + 1) : null : currentThread()))?.split(':').at(-1) || null;
  };
  const text = () => {
    const formatter = getFormatter(), now = Date.now();
    for (const { bar } of hosts.values()) {
      const timing = bar.cdtTimer, elapsed = timing?.active ? Math.max(0, now - timing.startedAtMs) : timing?.elapsedMs;
      const label = Number.isFinite(elapsed) && formatter
        ? formatter(elapsed, { locale: getLocale ? getLocale() : document.documentElement.lang || view.navigator.language, underOneSecond: 'zero', trimZeroUnits: true }) : null;
      const value = label || (bar.textContent ? null : '—');
      if (value !== null && bar.textContent !== value) bar.textContent = value;
    }
  };
  const remove = (host, owned) => {
    owned.bar.remove(); host.removeAttribute('data-cdt-running-composer-host'); host.removeAttribute('data-cdt-composer-working');
    owned.surface.removeAttribute('data-cdt-running-composer-surface'); hosts.delete(host);
  };
  const fail = error => { cleanup(); onError(error); };
  const timing = createRpcComposerTiming(getRpc, nativeComposerTiming, () => refresh(), fail, onDiagnostic);
  const render = () => {
    if (stopped) return;
    const rows = [...document.querySelectorAll('[data-codex-composer-root]')].map(composer => ({
      composer, host: composer.closest('[data-thread-scroll-footer="true"]'),
      surface: composer.querySelector('[role="presentation"][data-composer-surface-variant]'), visible: composer.getClientRects().length > 0,
    }));
    const retained = new Set(), client = getClient();
    let running = false;
    for (const { composer, host, surface, visible } of rows) {
      if (!host || !surface) continue;
      retained.add(host);
      let owned = hosts.get(host);
      if (!owned) {
        const bar = document.createElement('div'); bar.className = 'codex-composer-running-bar'; bar.setAttribute('aria-hidden', 'true');
        host.appendChild(bar); owned = { bar, surface }; hosts.set(host, owned);
      }
      const { bar } = owned, threadId = identity(composer);
      if (owned.surface !== surface) { owned.surface.removeAttribute('data-cdt-running-composer-surface'); owned.surface = surface; }
      if (owned.threadId !== threadId) { owned.threadId = threadId; bar.cdtTimer = null; bar.textContent = '—'; }
      set(host, 'data-cdt-running-composer-host', ''); set(surface, 'data-cdt-running-composer-surface', '');
      if (threadId) set(bar, 'data-cdt-live-thread-id', threadId); else bar.removeAttribute('data-cdt-live-thread-id');
      const value = threadId && (nativeComposerTiming(client, threadId) || timing.read(threadId));
      const source = value && nativeWorkedTiming(host.closest('[data-app-action-timeline-scroll],.thread-scroll-container'), value.turnId);
      const working = composerIsWorking(value, source);
      set(host, 'data-cdt-composer-working', String(working));
      if (value) {
        bar.cdtTimer = { ...value, active: working, startedAtMs: source?.startedAtMs ?? value.startedAtMs,
          elapsedMs: Number.isFinite(source?.completedAtMs) ? source.elapsedMs : value.elapsedMs };
        set(bar, 'data-codex-turn-id', value.turnId);
      }
      const diagnostic = { threadId, turnId: value?.turnId ?? null, active: working, timing: Boolean(value), sourceStatus: source?.status ?? null };
      const signature = JSON.stringify(diagnostic);
      if (bar.cdtTimingDiagnosticSignature !== signature) { bar.cdtTimingDiagnosticSignature = signature; onDiagnostic({ kind: 'render', ...diagnostic }); }
      running ||= working && visible && !document.hidden;
    }
    for (const [host, owned] of hosts) if (!retained.has(host)) remove(host, owned);
    text(); changed();
    if (running && interval === null) interval = view.setInterval(() => { try { text(); } catch (error) { fail(error); } }, 1000);
    else if (!running && interval !== null) { view.clearInterval(interval); interval = null; }
  };
  const refresh = () => {
    if (stopped || frame !== null) return;
    frame = view.requestAnimationFrame(() => { frame = null; try { render(); } catch (error) { fail(error); } });
  };
  const visibility = () => {
    if (document.hidden && interval !== null) { view.clearInterval(interval); interval = null; }
    if (!document.hidden) refresh();
  };
  function cleanup() {
    if (stopped) return;
    stopped = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    if (interval !== null) view.clearInterval(interval);
    timing.cleanup(); document.removeEventListener('visibilitychange', visibility);
    for (const [host, owned] of hosts) remove(host, owned);
  }
  document.addEventListener('visibilitychange', visibility); refresh();
  return { refresh, renderText: text, ready() { timing.ready(); refresh(); }, receive(method, params) { timing.receive(method, params); if (lifecycle.has(method)) refresh(); }, status: () => timing.status(), cleanup };
}
