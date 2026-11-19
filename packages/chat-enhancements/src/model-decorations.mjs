export function readComposerModelSelection(trigger) {
  const clean = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  const content = [...(trigger?.querySelectorAll('[class*="ModelPickerTriggerContent"]') || [])].find(element => !element.closest('[aria-hidden="true"]'));
  const key = trigger && Object.getOwnPropertyNames(trigger).find(name => name.startsWith('__reactFiber$'));
  let selection = null;
  for (let fiber = key ? trigger[key] : null; fiber; fiber = fiber.return) {
    if (Object.hasOwn(fiber.memoizedProps || {}, 'selectedServiceTierIconKind')) { selection = fiber.memoizedProps; break; }
  }
  return { model: clean(content?.querySelector('[class*="ModelPickerTriggerModelText"]')?.textContent),
    effort: clean(selection?.selectedLabelCandidate?.reasoningEffort) || clean(trigger?.dataset.selectedReasoningEffort),
    fast: selection?.selectedServiceTierIconKind === 'fast', available: Boolean(trigger && content && selection) };
}

export function sameModelSelection(left, right) {
  return Boolean(left?.available && right?.available && left.model && right.model && left.effort && right.effort
    && left.model.toLocaleLowerCase() === right.model.toLocaleLowerCase() && left.effort.toLocaleLowerCase() === right.effort.toLocaleLowerCase());
}

export function installModelDecorations(document, { currentThread, currentHost = () => 'local', bridge, onError, features = {}, fastLabel = () => 'Fast' }, readSelection, sameSelection) {
  const view = document.defaultView, metadata = new Map(), pending = new Map(), failedRequests = new Map(), retryRequests = new Set(), selections = new Map(), observed = new Set(), marked = new Set();
  const enabled = { emoji: true, fast: true, warning: true, ...features };
  let stopped = false, scheduled = false, emoji, lightning, fastSelection, warnings = [], hostId = currentHost(), activeRequests = new Set(), previousRequests = new Set(), reportedError = null;
  const bare = value => value?.split(':').at(-1) || null;
  const visible = element => element?.getClientRects().length && view.getComputedStyle(element).visibility !== 'hidden';
  const auxiliary = '[role="tabpanel"][data-tab-id^="background-agent:"],[role="tabpanel"][data-tab-id^="sidechat:"]';
  const pickerSelector = '[data-codex-intelligence-trigger="true"],[data-composer-navigation-target="reasoning"]';
  const reportRequests = () => {
    const error = [...activeRequests].map(id => failedRequests.get(id)).find(Boolean) || null;
    if (error !== reportedError) { reportedError = error; onError(error); }
  };
  const retryTimeout = id => { if (!pending.has(id) && failedRequests.get(id)?.message === 'mcp-response timed out.') retryRequests.add(id); };
  const hydrate = id => {
    if (!id) return;
    activeRequests.add(id);
    if (!previousRequests.has(id)) retryTimeout(id);
    if (metadata.has(id) || pending.has(id) || failedRequests.has(id) && !retryRequests.delete(id)) return;
    const requestedHost = currentHost();
    const job = bridge.appServer('thread/read', { threadId: id, includeTurns: false }, { hostId: requestedHost, source: 'codex_toolkit_chat_decorations' }).then(result => {
      if (result?.thread?.id !== id) throw new Error('聊天装饰收到不同的会话 ID。');
      if (stopped || currentHost() !== requestedHost) return;
      const thread = result.thread;
      metadata.set(id, { title: thread.name || thread.title || '', parent: bare(thread.parentThreadId || thread.source?.subAgent?.thread_spawn?.parent_thread_id) });
      failedRequests.delete(id); reportRequests();
      schedule();
    }).catch(error => { if (!stopped && currentHost() === requestedHost) { failedRequests.set(id, error); reportRequests(); } }).finally(() => { if (pending.get(id) === job) pending.delete(id); });
    pending.set(id, job);
  };
  const observer = new view.MutationObserver(() => schedule());
  const decorate = (node, id, value, anchor, title) => {
    if (!value || !anchor) { node?.remove(); return null; }
    if (!node) { node = document.createElement('div'); node.id = id; node.dataset.cdtkChatOwned = ''; node.setAttribute('aria-hidden', 'true'); }
    if (node.parentElement !== anchor) anchor.appendChild(node);
    if (node.textContent !== value) node.textContent = value;
    if (node.title !== title) node.title = title;
    return node;
  };
  const refresh = () => {
    if (stopped) return;
    if (hostId !== currentHost()) { hostId = currentHost(); metadata.clear(); pending.clear(); failedRequests.clear(); retryRequests.clear(); selections.clear(); }
    const id = bare(currentThread()), triggers = enabled.fast || enabled.warning ? [...document.querySelectorAll(pickerSelector)] : [];
    previousRequests = activeRequests; activeRequests = new Set();
    const next = new Set(triggers);
    if (next.size !== observed.size || [...next].some(node => !observed.has(node))) {
      observer.disconnect(); observed.clear();
      for (const trigger of triggers) { observed.add(trigger); observer.observe(trigger, { subtree: true, childList: true, characterData: true, attributes: true }); }
    }
    const mainTrigger = triggers.find(node => !node.closest('[role="tabpanel"]') && visible(node));
    const mainSelection = readSelection(mainTrigger);
    if (enabled.warning && id && mainSelection.available) selections.set(id, mainSelection);
    if (enabled.emoji) hydrate(id);
    const editor = enabled.emoji || enabled.fast ? [...document.querySelectorAll('[role="textbox"][contenteditable="true"],textarea')].find(node => !node.closest('[role="tabpanel"]') && node.closest('main') && visible(node)) : null;
    const composer = editor?.closest('[class*="ComposerLayoutRoot"],[class*="ComposerLayoutBody"]') || editor;
    let anchor = composer;
    for (let candidate = composer?.parentElement; candidate; candidate = candidate.parentElement) {
      const css = view.getComputedStyle(candidate);
      if (css.position !== 'static' && css.overflowX === 'visible' && css.overflowY === 'visible') { anchor = candidate; break; }
    }
    if (enabled.emoji) {
      const title = metadata.get(id)?.title || view.electronBridge?.getInitialSidebarBootstrap?.()?.catalogEntries?.find(entry => entry.threadId === id)?.displayTitle || '';
      const first = title.match(/\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*/u)?.[0];
      emoji = decorate(emoji, 'codex-thread-emoji-indicator', first, anchor, title);
    }
    if (enabled.fast) { fastSelection = mainSelection; lightning = decorate(lightning, 'codex-thread-speed-indicator', mainSelection.fast ? '⚡' : null, anchor, [mainSelection.model, mainSelection.effort, fastLabel()].filter(Boolean).join(' · ')); }
    const retained = new Set(); warnings = [];
    for (const host of enabled.warning ? document.querySelectorAll(auxiliary) : []) {
      const tab = host.getAttribute('data-tab-id'), split = tab.indexOf(':'), kind = tab.slice(0, split), child = bare(tab.slice(split + 1));
      const trigger = host.querySelector(pickerSelector);
      const surface = trigger?.closest('[role="presentation"][data-composer-surface-variant]') || trigger?.closest('[data-codex-composer-root]')?.querySelector('[role="presentation"]');
      if (!child || !surface || !visible(host)) continue;
      const selection = readSelection(trigger); if (selection.available) selections.set(child, selection);
      if (kind === 'background-agent') hydrate(child);
      const parent = kind === 'sidechat' ? id : metadata.get(child)?.parent;
      const warning = sameSelection(selection, parent === id ? mainSelection : selections.get(parent));
      retained.add(surface); marked.add(surface);
      if (surface.classList.contains('codex-inherited-model-warning') !== warning) surface.classList.toggle('codex-inherited-model-warning', warning);
      const value = String(warning); if (surface.dataset.codexModelInheritanceWarning !== value) surface.dataset.codexModelInheritanceWarning = value;
      warnings.push({ kind, threadId: child, parentThreadId: parent || null, warning, selection });
    }
    for (const surface of marked) if (!retained.has(surface)) { surface.classList.remove('codex-inherited-model-warning'); delete surface.dataset.codexModelInheritanceWarning; marked.delete(surface); }
    reportRequests();
  };
  function schedule() { if (!scheduled && !stopped) { scheduled = true; view.queueMicrotask(() => { scheduled = false; try { refresh(); } catch (error) { onError(error); } }); } }
  return { refresh, updateText() { if (lightning) { const title = [fastSelection.model, fastSelection.effort, fastLabel()].filter(Boolean).join(' · '); if (lightning.title !== title) lightning.title = title; } }, status: () => ({ warnings, emoji: emoji?.textContent || null, fast: Boolean(lightning) }),
    receive(method, params) { const id = bare(params.threadId || params.thread?.id); if (method === 'thread/name/updated') metadata.delete(id); if (['thread/name/updated', 'thread/settings/updated', 'thread/started', 'turn/started'].includes(method)) { retryTimeout(id); schedule(); } },
    cleanup() { stopped = true; observer.disconnect(); emoji?.remove(); lightning?.remove(); for (const surface of marked) { surface.classList.remove('codex-inherited-model-warning'); delete surface.dataset.codexModelInheritanceWarning; } if (reportedError) { reportedError = null; onError(null); } },
  };
}
