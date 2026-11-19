export function installChatRenderer(window, initial, helpers) {
  const key = '__CODEX_DESKTOP_TOOLKIT_CHAT__', binding = '__CDTK_CHAT_BRIDGE__', styleId = 'cdtk-chat-style';
  const document = window.document;
  if (window !== window.top) return { applicable: false };
  if (window.__CODEX_DYNAMIC_THEME__) throw new Error('旧控制器仍在此页面运行；请先停止旧注入，再启用聊天增强。');
  if (window[key]?.epoch === initial.epoch) return window[key].update(initial);
  const retained = window[key]?.snapshot?.();
  window[key]?.cleanup();
  if (document.readyState === 'loading') {
    let latest = initial;
    const start = () => {
      delete window[key];
      try { installChatRenderer(window, latest, helpers); }
      catch (error) { window[binding](JSON.stringify({ kind: 'state', applicable: false, errors: [{ source: 'startup', name: error.name, message: error.message, stack: error.stack }], capabilities: {} })); }
    };
    window[key] = { epoch: initial.epoch, update(value) { latest = value; return { pending: true }; },
      setHostState(hostState) { latest = { ...latest, hostState }; }, setUsage(usage) { latest = { ...latest, usage }; },
      setHardReset(hardReset) { latest = { ...latest, hardReset }; },
      cleanup() { document.removeEventListener('DOMContentLoaded', start); delete window[key]; } };
    document.addEventListener('DOMContentLoaded', start, { once: true }); return { pending: true };
  }
  const { chatCss, createNativeAssetReader, loadNativeConversationRpc, loadNativeDurationFormatter, readNativeConversationIdentity, readNativeNotification,
    findNativeConversationStore, findNativeUsageClient, findNativeRateLimitQuery, isNativeRateLimitQuery, nativeUsageSnapshot,
    installUsageToolbar, installContextUi, installComposerUi, installSpeedUi, createOutputSpeedTracker,
    installMessageLabels, assistantMessageOrdinals, messageLabelTime, messageOrdinalColor,
    installTurnHistoryControl, readTurnHistoryDisclosure,
    installLiveOutput, appendLiveOutput, installFileLineHighlight, createNativeBridgeClient,
    installModelDecorations, readComposerModelSelection, sameModelSelection, installSelectionActions, installRichPaste, sanitizeRichPaste, hardResetRange,
    installScrollHandoffRepair, scrollHandoffCorrection, installScrollDiagnostics } = helpers;
  let state = initial, stopped = false, initialized = false, scheduled = false, lastReport = null, lastUsage = null, client = null, rpc = null, formatter = null, nativeReady = null, nativeLoading = false;
  let toolbar, context, composer, speed, labels, history, output, highlight, decorations, usageClient, unsubscribeUsage;
  let scrollHandoff, scrollDiagnostics;
  const notificationCallbacks = new Set();
  const errors = new Map(), requests = new Map();
  const assets = createNativeAssetReader(document), owned = new Set();
  const bridge = createNativeBridgeClient(window);
  const send = value => { if (!stopped) { if (typeof window[binding] !== 'function') throw new Error('聊天增强的控制器连接不可用。'); window[binding](JSON.stringify(value)); } };
  const applicable = () => window.location.pathname !== '/detached-window.html' && [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(element => !element.closest('[data-app-shell-tab-panel-controller="right"]'));
  const currentIdentity = () => readNativeConversationIdentity(document);
  const currentThread = () => currentIdentity()?.taskKey || null;
  const currentHost = () => currentIdentity()?.hostId || 'local';
  const getRpc = () => rpc?.forHost(currentHost()) || null;
  const report = () => {
    const value = { kind: 'state', applicable: applicable(), threadId: currentThread(), errors: [...errors].map(([source, error]) => ({ source, name: error.name, message: error.message, stack: error.stack })),
      capabilities: { initialized, rpc: Boolean(rpc), formatter: Boolean(formatter), usage: Boolean(usageClient), speedPanels: speed?.status().panels || [], decorations: decorations?.status() || null,
        scrollHandoff: scrollHandoff?.status(), scrollDiagnostics: scrollDiagnostics?.status() } };
    const signature = JSON.stringify(value); if (signature !== lastReport) { lastReport = signature; send(value); }
    return value;
  };
  const failed = source => error => { if (!stopped) { if (error) errors.set(source, error); else errors.delete(source); report(); } };
  const diagnostic = feature => value => send({ kind: 'diagnostic', feature, record: value });
  const getClient = () => { if (!client || client.disposed || client.hostId !== currentHost()) client = findNativeConversationStore(document.getElementById('root'), currentHost()); return client; };
  const loadIndex = identity => new Promise((resolve, reject) => {
    const requestId = window.crypto.randomUUID(); requests.set(requestId, { resolve, reject });
    try { send({ kind: 'history-index', requestId, ...identity }); } catch (error) { requests.delete(requestId); reject(error); }
  });
  const refreshUsage = () => {
    if (state.externalWeeklyUsage) return;
    if (!usageClient) {
      const found = findNativeUsageClient(document, findNativeRateLimitQuery);
      if (!found) return;
      usageClient = found;
      unsubscribeUsage = found.getQueryCache().subscribe(event => { if (isNativeRateLimitQuery(event?.query)) { try { refreshUsage(); } catch (error) { failed('usage')(error); } } });
    }
    const snapshot = nativeUsageSnapshot(usageClient, findNativeRateLimitQuery);
    if (snapshot) {
      toolbar.update(snapshot);
      errors.delete('usage');
      const signature = JSON.stringify(snapshot);
      if (signature !== lastUsage) { lastUsage = signature; send({ kind: 'usage', snapshot }); }
    }
  };
  const loadNative = () => {
    if (nativeLoading) return nativeReady;
    nativeLoading = true;
    const loads = [];
    if (!rpc || errors.has('conversation-rpc')) loads.push(loadNativeConversationRpc(document, { assets }).then(host => { if (!stopped) { rpc = host; composer?.ready(); history?.refresh(); errors.delete('conversation-rpc'); } }).catch(failed('conversation-rpc')));
    if (!formatter || errors.has('duration-formatter')) loads.push(loadNativeDurationFormatter(document, { assets }).then(value => { if (!stopped) { formatter = value; composer?.refresh(); errors.delete('duration-formatter'); } }).catch(failed('duration-formatter')));
    nativeReady = Promise.all(loads).then(() => { if (!stopped) report(); }).catch(failed('native')).finally(() => { nativeLoading = false; });
    return nativeReady;
  };
  const initialize = () => {
    if (initialized || !applicable()) return;
    initialized = true;
    const style = document.createElement('style'); style.id = styleId; style.textContent = chatCss(state.externalWeeklyUsage, state.externalKits); document.head.appendChild(style);
    if (!state.externalWeeklyUsage) {
      toolbar = installUsageToolbar(document, () => state.hostState, helpers.weeklyProgress, helpers.acquireFooter, hardResetRange); owned.add(toolbar);
      if (state.usage) toolbar.update(state.usage);
      toolbar.setHardReset(state.hardReset);
    }
    const decorationFeatures = { emoji: !state.externalKits?.includes('title-emoji'), fast: !state.externalKits?.includes('fast-mode-indicator'), warning: !state.externalKits?.includes('child-model-warning') };
    if (Object.values(decorationFeatures).some(Boolean)) { decorations = installModelDecorations(document, { currentThread, currentHost, bridge, onError: failed('decorations'), features: decorationFeatures }, readComposerModelSelection, sameModelSelection); owned.add(decorations); }
    if (!state.externalKits?.includes('selection-actions-delay')) owned.add(installSelectionActions(document));
    if (!state.externalKits?.includes('rich-paste-boundary')) owned.add(installRichPaste(document, sanitizeRichPaste, diagnostic('paste'), failed('paste')));
    if (!state.externalKits?.includes('live-model-output')) { output = installLiveOutput(document, appendLiveOutput); owned.add(output); }
    if (!state.externalKits?.includes('context-meter')) { context = installContextUi(document, currentThread, helpers, failed('context')); owned.add(context); }
    let tracker;
    if (!state.externalKits?.includes('output-speed')) {
      tracker = createOutputSpeedTracker(() => speed?.update(), retained?.speed);
      speed = installSpeedUi(document, tracker, currentThread, failed('speed'), report); owned.add(speed);
    }
    if (!state.externalKits?.includes('composer-timer')) {
      composer = installComposerUi(document, { getClient, getRpc, currentThread, getFormatter: () => formatter,
        onError: failed('timer'), onDiagnostic: diagnostic('timer'), changed: () => output?.refresh() }, helpers); owned.add(composer);
    }
    if (!state.externalKits?.includes('message-labels')) { labels = installMessageLabels(document, getClient, assistantMessageOrdinals, messageLabelTime, messageOrdinalColor, loadIndex, failed('labels')); owned.add(labels); }
    if (!state.externalKits?.includes('history-show-all')) { history = installTurnHistoryControl(document, getClient, readTurnHistoryDisclosure, failed('history'), getRpc); owned.add(history); }
    if (!state.externalKits?.includes('file-line-highlight')) { highlight = installFileLineHighlight(document); owned.add(highlight); }
    window[key].tracker = tracker;
    if (state.scrollHandoffEnabled && !state.externalKits?.includes('scroll-handoff-fix')) {
      scrollHandoff = installScrollHandoffRepair(document, scrollHandoffCorrection, diagnostic('scroll-handoff'), failed('scroll-handoff')); owned.add(scrollHandoff);
    }
    if (state.scrollDiagnosticsEnabled && !state.externalKits?.includes('scroll-diagnostics')) {
      const notifications = { addNotificationCallback(methods, listener) { const value = { methods, listener }; notificationCallbacks.add(value); return () => notificationCallbacks.delete(value); } };
      scrollDiagnostics = installScrollDiagnostics(document, notifications, diagnostic('scroll'), failed('scroll'), state.epoch); owned.add(scrollDiagnostics);
    }
    loadNative();
  };
  const refresh = () => {
    if (stopped) return;
    try {
      initialize();
      if (initialized) {
        toolbar?.refresh(); context?.refresh(); composer?.refresh(); speed?.refresh(); labels?.refresh(); history?.refresh(); output?.refresh(); decorations?.refresh(); refreshUsage(); scrollHandoff?.refresh();
        scrollDiagnostics?.refresh();
      }
      errors.delete('renderer');
      report();
    } catch (error) { failed('renderer')(error); }
  };
  const schedule = () => { if (!scheduled && !stopped) { scheduled = true; window.queueMicrotask(() => { scheduled = false; refresh(); }); } };
  const watch = 'main,[class*="_Workspace_"],[data-codex-composer-root],[data-app-action-timeline-scroll],.thread-scroll-container,[role="tabpanel"][data-tab-id],[data-above-composer-conversation-id]';
  const observer = new window.MutationObserver(records => {
    if (records.some(record => {
      if (record.target.id === styleId || record.target.parentElement?.id === styleId || record.target.closest?.('[data-cdtk-chat-owned],#codex-usage-toolbar,.codex-composer-running-bar,.codex-live-output-overlay')) return false;
      if (record.type === 'attributes') return record.target.matches?.(watch);
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches?.(watch) || node.querySelector?.(watch)));
    })) schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state', 'data-tab-id', 'data-above-composer-conversation-id'] });
  const receive = event => {
    if (stopped || event.source && event.source !== window || event.data?.hostId && event.data.hostId !== currentHost()) return;
    if (event.data?.type === 'mcp-request') { try { output?.receive(event.data.request?.method, event.data.request?.params || {}); } catch (error) { failed('notification')(error); } return; }
    if (event.data?.type !== 'mcp-notification') return;
    try {
      const notification = readNativeNotification(event.data), { method, params } = notification;
      for (const entry of notificationCallbacks) if (entry.methods.includes(method)) entry.listener(notification);
      window[key].tracker?.receive(method, params); composer?.receive(method, params); context?.receive(method, params); output?.receive(method, params); decorations?.receive(method, params);
      if (['item/started', 'item/completed', 'turn/completed'].includes(method)) labels?.refresh();
    }
    catch (error) { failed('notification')(error); }
  };
  const visibility = () => {
    const hidden = document.hidden;
    if (document.documentElement.classList.contains('cdtk-chat-hidden') !== hidden) document.documentElement.classList.toggle('cdtk-chat-hidden', hidden);
    if (!hidden) schedule();
  };
  window.addEventListener('message', receive); document.addEventListener('visibilitychange', visibility);
  window[key] = {
    epoch: initial.epoch,
    update(value) { state = value; toolbar?.refresh(); return report(); },
    setHostState(value) { state = { ...state, hostState: value }; toolbar?.refresh(); return true; },
    setUsage(value) { state = { ...state, usage: value }; toolbar?.update(value); return true; },
    setHardReset(value) { state = { ...state, hardReset: value }; toolbar?.setHardReset(value); return true; },
    refreshLiveOutput() { output?.refresh(); },
    resolveHistoryIndex(id, result, error) { const request = requests.get(id); if (!request) return false; requests.delete(id); error ? request.reject(Object.assign(new Error(error.message), error)) : request.resolve(result); return true; },
    refresh() { refresh(); return nativeReady?.then(report) || report(); },
    recover() { refresh(); return initialized ? loadNative().then(report) : report(); },
    snapshot: () => ({ speed: window[key]?.tracker?.snapshot() }),
    cleanup() {
      stopped = true; observer.disconnect(); window.removeEventListener('message', receive); document.removeEventListener('visibilitychange', visibility);
      for (const request of requests.values()) request.reject(new Error('聊天增强已停止。')); requests.clear();
      for (const item of [...owned].reverse()) item.cleanup(); owned.clear(); unsubscribeUsage?.(); bridge.close();
      document.getElementById(styleId)?.remove(); document.documentElement.classList.remove('cdtk-chat-hidden'); delete window[key];
    },
  };
  visibility(); schedule(); return report();
}
