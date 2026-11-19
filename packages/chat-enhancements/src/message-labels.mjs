// Serialized into the renderer alongside the existing native client adapter.
export function assistantMessageOrdinals(turn) {
  if (!turn || turn.itemsPagination?.hasLoadedOldest === false) return new Map();
  const result = new Map();
  for (const item of turn.items || []) {
    if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim() && !result.has(item.id)) {
      result.set(item.id, result.size + 1);
    }
  }
  return result;
}

export function messageLabelTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return date.getHours() + ':' + String(date.getMinutes()).padStart(2, '0');
}

export function messageOrdinalColor(ordinal) {
  // An HSV hue-ring color at full saturation/value, mixed 1:1 with white,
  // is equivalently HSL(hue, 100%, 75%). Keep the former odd-numbered hues:
  // red, yellow, green, cyan, blue, purple. All colors remain opaque.
  return 'hsl(' + (((ordinal - 1) % 6 + 6) % 6 * 60) + ' 100% 75%)';
}

export function installMessageLabels(document, getClient, ordinals, formatTime, color, loadIndex, onError = error => console.error('[Codex Dynamic Theme] message labels failed', error)) {
  const view = document.defaultView;
  let client = null, frame = null, stopped = false;
  let eligible = 0, nativeResolved = 0;
  const unsubscribers = [];
  const historicalIndexes = new Map();
  const firstLines = new Map(), toolRails = new Set(), railScopes = new Set(), anchorNames = new WeakMap();
  let nextAnchor = 0;
  const selector = '[data-response-annotation-conversation][data-response-annotation-target]';
  const attributes = ['data-cdt-message-number', 'data-cdt-message-time'];
  const setStyle = (element, name, value) => {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
  };
  const clearFirstLine = element => {
    const first = firstLines.get(element);
    if (first?.hasAttribute('data-cdt-message-number-label')) first.removeAttribute('data-cdt-message-number-label');
    firstLines.delete(element);
    if (element.hasAttribute('data-cdt-message-inline-number')) element.removeAttribute('data-cdt-message-inline-number');
  };
  const firstLine = element => {
    const markdown = element.querySelector('[data-markdown-text-style="assistant-message"]');
    if (!markdown) return null;
    const walker = document.createTreeWalker(markdown, view.NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim() || text.parentElement.closest('button,svg,[aria-hidden="true"]')) continue;
      const block = text.parentElement.closest('p,h1,h2,h3,h4,h5,h6,li,th,td');
      // Code/other non-inline surfaces keep their outside-gutter number rather
      // than placing a generated label inside a clipping/scrolling code block.
      return block && markdown.contains(block) ? block : null;
    }
    return null;
  };
  const clearToolRail = element => {
    element.classList.remove('codex-message-tool-rail');
    element.style.removeProperty('--cdt-message-number-color');
    element.style.removeProperty('--cdt-message-number-anchor');
    element.style.removeProperty('--cdt-message-end-anchor');
  };
  const clearScope = element => {
    element.classList.remove('codex-message-rail-scope');
    element.style.removeProperty('--cdt-message-number-anchors');
  };
  const clear = (element) => {
    clearFirstLine(element);
    if (element.classList.contains('codex-message-label')) element.classList.remove('codex-message-label');
    for (const name of attributes) if (element.hasAttribute(name)) element.removeAttribute(name);
    element.style.removeProperty('--cdt-message-number-color');
    element.style.removeProperty('--cdt-message-number-anchor');
    element.style.removeProperty('--cdt-message-host-anchor');
    element.style.removeProperty('--cdt-message-number-box-anchor');
    element.style.removeProperty('--cdt-message-end-anchor');
    element.style.removeProperty('--cdt-message-previous-end');
  };
  const nativeMessage = (element) => {
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
    let item = null, turnId = null, turn = null;
    for (let fiber = key ? element[key] : null; fiber; fiber = fiber.return) {
      let root = fiber;
      while (root.return) root = root.return;
      const current = root.stateNode?.current && root.stateNode.current !== root ? fiber.alternate ?? fiber : fiber;
      const props = current.memoizedProps;
      if (!item && props?.item?.type === 'assistant-message') item = props.item;
      if (typeof props?.turnId === 'string') turnId ||= props.turnId;
      if (typeof props?.turn?.turnId === 'string') {
        turnId ||= props.turn.turnId;
        if (props.turn.turnId === turnId && Array.isArray(props.turn.items)) { turn = props.turn; break; }
      }
    }
    // Search/display keys can be synthetic (e.g. realtime-voice:...); the
    // native turn identity takes precedence for historical and expanded items.
    turnId ||= element.closest('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key');
    return { item, turnId, turn };
  };
  const render = () => {
    if (stopped) return;
    eligible = 0; nativeResolved = 0;
    const indexes = new Map();
    const numbered = new Map();
    for (const element of document.querySelectorAll(selector)) {
      const { item, turnId, turn: renderedTurn } = nativeMessage(element);
      if (!item) { clear(element); continue; }
      eligible++;
      const threadId = element.getAttribute('data-response-annotation-conversation');
      const itemId = element.getAttribute('data-response-annotation-target');
      const indexKey = threadId + ':' + (turnId || itemId);
      if (!indexes.has(indexKey)) {
        const conversation = client?.getConversation(threadId);
        const entities = conversation?.turnHistory?.history?.entitiesByKey;
        // New renderers keep the manager behind RPC, but pass the original
        // agentMessage turn to the native transcript component. It includes
        // collapsed items too; never count only the currently mounted DOM.
        const turn = renderedTurn || (turnId ? client?.getTurn?.(threadId, turnId) : null) || entities?.['turn:' + turnId]
          || Object.values(entities || {}).find((entry) => entry.turnId === turnId || entry.items?.some(i => i.id === itemId))
          || conversation?.turns?.find((entry) => entry.turnId === turnId);
        indexes.set(indexKey, { turn, ordinals: ordinals(turn) });
      }
      const nativeIndex = indexes.get(indexKey);
      if (nativeIndex.turn) nativeResolved++;
      if (loadIndex && turnId && nativeIndex.turn && nativeIndex.turn.status !== 'inProgress'
          && (nativeIndex.turn.itemsPagination?.hasLoadedOldest === false || !Number.isFinite(item.sentAtMs))
          && !historicalIndexes.has(indexKey)) {
        const entry = { pending: true, messages: null, error: null };
        historicalIndexes.set(indexKey, entry);
        Promise.resolve().then(() => loadIndex({ threadId, turnId, anchorItemId: itemId })).then(result => {
          if (stopped) return;
          if (result?.threadId !== threadId || result?.turnId !== turnId || !Array.isArray(result.messages)
              || !result.messages.some(message => message.itemId === itemId)) {
            throw new Error('Historical message labels received a mismatched index: ' + turnId);
          }
          const messages = new Map();
          for (const [index, message] of result.messages.entries()) {
            if (typeof message.itemId !== 'string' || message.ordinal !== index + 1 || messages.has(message.itemId)
                || (message.timestamp !== null && !Number.isFinite(message.timestamp))) {
              throw new Error('Historical message labels received an invalid index: ' + turnId);
            }
            messages.set(message.itemId, message);
          }
          entry.pending = false;
          entry.messages = messages;
          refresh();
        }).catch(error => {
          if (stopped) return;
          entry.pending = false;
          entry.error = error;
          onError(error);
          refresh();
        });
      }
      const historical = historicalIndexes.get(indexKey)?.messages?.get(itemId);
      const ordinal = historical?.ordinal ?? nativeIndex.ordinals.get(itemId);
      const time = formatTime(historical?.timestamp ?? item.sentAtMs);
      if (!ordinal && !time) { clear(element); continue; }
      if (!element.classList.contains('codex-message-label')) element.classList.add('codex-message-label');
      let anchor = anchorNames.get(element);
      if (!anchor) { anchor = '--cdt-message-number-' + (++nextAnchor); anchorNames.set(element, anchor); }
      setStyle(element, '--cdt-message-number-anchor', anchor);
      setStyle(element, '--cdt-message-host-anchor', anchor + '-host');
      setStyle(element, '--cdt-message-number-box-anchor', anchor + '-box');
      setStyle(element, '--cdt-message-end-anchor', anchor + '-end');
      if (ordinal) {
        if (element.getAttribute('data-cdt-message-number') !== String(ordinal)) element.setAttribute('data-cdt-message-number', String(ordinal));
        const numberColor = color(ordinal);
        if (element.style.getPropertyValue('--cdt-message-number-color') !== numberColor) element.style.setProperty('--cdt-message-number-color', numberColor);
        const first = firstLine(element);
        if (firstLines.get(element) !== first) clearFirstLine(element);
        if (first) {
          firstLines.set(element, first);
          if (!element.hasAttribute('data-cdt-message-inline-number')) element.setAttribute('data-cdt-message-inline-number', '');
          if (first.getAttribute('data-cdt-message-number-label') !== String(ordinal)) first.setAttribute('data-cdt-message-number-label', String(ordinal));
        }
        numbered.set(element, { anchor, endAnchor: anchor + '-end', color: numberColor, threadId, turnId });
      } else {
        if (element.hasAttribute('data-cdt-message-number')) element.removeAttribute('data-cdt-message-number');
        clearFirstLine(element);
        element.style.removeProperty('--cdt-message-previous-end');
      }
      if (time) {
        if (element.getAttribute('data-cdt-message-time') !== time) element.setAttribute('data-cdt-message-time', time);
      } else if (element.hasAttribute('data-cdt-message-time')) element.removeAttribute('data-cdt-message-time');
    }
    for (const [element] of firstLines) if (!numbered.has(element)) clearFirstLine(element);
    const scopes = new Map(), groups = new Set(), rails = new Map(), previousEnds = new Map();
    for (const [element, meta] of numbered) {
      const pane = element.closest('[data-thread-user-message-navigation-content]') || element.closest('[role="tabpanel"]')
        || element.closest('main') || document.documentElement;
      if (!previousEnds.has(pane)) previousEnds.set(pane, new Map());
      const previous = previousEnds.get(pane), key = meta.threadId + ':' + meta.turnId;
      setStyle(element, '--cdt-message-previous-end', previous.get(key) || '--cdt-message-no-previous');
      previous.set(key, meta.endAnchor);
      const group = element.closest('[class~="group/agent-activity"]');
      const scope = group || element;
      if (!scopes.has(scope)) scopes.set(scope, []);
      scopes.get(scope).push(meta.anchor);
      if (group) groups.add(group);
    }
    // Native activity children already delimit one message and the following
    // tool items. Paint their existing boxes; never wrap/reparent React nodes
    // or measure height. The next message starts a new rail/color.
    for (const group of groups) {
      let current = null;
      for (const child of group.children) {
        const message = child.matches(selector) ? child : child.querySelector(selector);
        if (message) current = numbered.get(message) || null;
        else if (child.matches('[data-conversation-role="user"],[data-user-message-bubble]')
            || child.querySelector('[data-conversation-role="user"],[data-user-message-bubble]')) current = null;
        else if (current && child.hasAttribute('data-local-conversation-item-target-ids')) rails.set(child, current);
      }
    }
    for (const element of toolRails) if (!rails.has(element)) { clearToolRail(element); toolRails.delete(element); }
    for (const [element, meta] of rails) {
      if (!element.classList.contains('codex-message-tool-rail')) element.classList.add('codex-message-tool-rail');
      setStyle(element, '--cdt-message-number-color', meta.color);
      setStyle(element, '--cdt-message-number-anchor', meta.anchor);
      setStyle(element, '--cdt-message-end-anchor', meta.endAnchor);
      toolRails.add(element);
    }
    for (const element of railScopes) if (!scopes.has(element)) { clearScope(element); railScopes.delete(element); }
    for (const [element, anchors] of scopes) {
      if (!element.classList.contains('codex-message-rail-scope')) element.classList.add('codex-message-rail-scope');
      setStyle(element, '--cdt-message-number-anchors', anchors.join(','));
      railScopes.add(element);
    }
  };
  const refresh = () => {
    if (stopped) return;
    if (!client || client.disposed) {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      client = getClient();
      if (client && typeof client.addAnyConversationMetaCallback === 'function'
          && typeof client.addAcceptedHistoryListener === 'function' && typeof client.addNotificationCallback === 'function') {
        unsubscribers.push(client.addAnyConversationMetaCallback(refresh));
        unsubscribers.push(client.addAcceptedHistoryListener(refresh));
        unsubscribers.push(client.addNotificationCallback(['item/started', 'item/completed', 'turn/completed'], refresh));
      }
    }
    if (frame === null) frame = view.requestAnimationFrame(() => { frame = null; render(); });
  };
  // Expanding an already-loaded historical activity does not emit a new model
  // or accepted-history event. Observe message mounts/identity changes directly,
  // scheduling the same render; do not depend on theme refresh or polling.
  const observer = new view.MutationObserver((records) => {
    const mounts = selector + ',[data-local-conversation-item-target-ids]';
    const containsMessage = node => node.nodeType === 1 && (node.matches(mounts) || node.querySelector(mounts));
    if (records.some(record => record.type === 'attributes'
      ? record.target.matches(selector) || record.target.querySelector(selector)
      : record.target?.closest?.(selector) || [...record.addedNodes, ...record.removedNodes].some(containsMessage))) refresh();
  });
  observer.observe(document.getElementById('root') || document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-response-annotation-conversation', 'data-response-annotation-target', 'hidden', 'aria-expanded', 'data-state'],
  });
  refresh();
  return {
    refresh,
    status: () => ({ nativeSubscribed: unsubscribers.length === 3, nativeReady: unsubscribers.length === 3 || nativeResolved === eligible,
      eligible, nativeResolved, domObserved: !stopped,
      labeled: document.querySelectorAll('[data-cdt-message-number]').length,
      inlineNumbers: firstLines.size, toolRails: toolRails.size,
      historicalIndexes: [...historicalIndexes.values()].filter(entry => entry.messages).length,
      error: [...historicalIndexes.values()].find(entry => entry.error)?.error.message || null }),
    cleanup() {
      stopped = true;
      observer.disconnect();
      if (frame !== null) view.cancelAnimationFrame(frame);
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      historicalIndexes.clear();
      for (const element of document.querySelectorAll('.codex-message-label')) clear(element);
      for (const [element] of firstLines) clearFirstLine(element);
      for (const element of toolRails) clearToolRail(element);
      for (const element of railScopes) clearScope(element);
      toolRails.clear(); railScopes.clear();
    },
  };
}
