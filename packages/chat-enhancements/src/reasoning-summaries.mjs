// Read only the public summary field, never reasoning.content.
export function publicReasoningSummaries(turn) {
  const entries = new Map();
  for (const item of turn?.items || []) {
    if (item.type !== 'reasoning' || typeof item.id !== 'string') continue;
    for (const [index, part] of (item.summary || []).entries()) {
      const text = typeof part === 'string' ? part : part?.text;
      if (typeof text !== 'string' || !text.trim()) continue;
      entries.set(item.id + ':' + index, { key: item.id + ':' + index, text });
    }
  }
  return [...entries.values()];
}

export function installReasoningSummaries(document, getClient, readSummaries, onError = error => { throw error; }) {
  const view = document.defaultView;
  let client = null, frame = null, stopped = false;
  let anchorCount = 0, nativeResolved = 0, failure = null;
  const unsubscribers = [];
  const identity = (header) => {
    const key = Object.getOwnPropertyNames(header).find((name) => name.startsWith('__reactFiber$'));
    let threadId, turnId, turn;
    for (let fiber = key ? header[key] : null; fiber; fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (typeof props?.conversationId === 'string') threadId ||= props.conversationId;
      turnId ||= props?.turnId || props?.turn?.turnId;
      if (typeof turnId === 'string' && props?.turn?.turnId === turnId && Array.isArray(props.turn.items)) {
        turn = props.turn; break;
      }
    }
    turnId ||= header.closest('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key');
    return threadId && turnId ? { threadId, turnId, turn } : null;
  };
  const render = () => {
    if (stopped) return;
    const retained = new Set();
    const turns = new Map();
    const anchors = new Map();
    const addAnchor = (header) => {
      const id = identity(header);
      if (id?.turnId) anchors.set(id.threadId + ':' + id.turnId, { header, id });
    };
    for (const header of document.querySelectorAll('[class~="group/activity-header"]')) addAnchor(header);
    // Completed turns use the Worked for disclosure instead of activity-header.
    for (const button of document.querySelectorAll('[data-content-search-turn-key] button[aria-expanded]')) {
      const key = Object.getOwnPropertyNames(button).find((name) => name.startsWith('__reactFiber$'));
      for (let fiber = key ? button[key] : null; fiber; fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if ((props?.units && typeof props.onSetCollapsed === 'function' && 'workedDurationMs' in props)
          || (props && 'collapsedMessageCount' in props && 'workedDurationMs' in props && 'isCollapsed' in props)) {
          addAnchor(button.parentElement);
          break;
        }
        // Action menus are not the native turn disclosure.
        if (props?.item?.type === 'assistant-message') break;
      }
    }
    for (const { header, id } of anchors.values()) {
      const cacheKey = id.threadId + ':' + id.turnId;
      if (!turns.has(cacheKey)) {
        const conversation = client?.getConversation(id.threadId);
        const entities = conversation?.turnHistory?.history?.entitiesByKey;
        const turn = id.turn || entities?.['turn:' + id.turnId]
          || Object.values(entities || {}).find((entry) => entry.turnId === id.turnId)
          || conversation?.turns?.find((entry) => entry.turnId === id.turnId);
        turns.set(cacheKey, readSummaries(turn));
      }
      const summaries = turns.get(cacheKey);
      let body = header.nextElementSibling;
      if (!body?.classList.contains('codex-reasoning-summaries')) body = null;
      if (!summaries.length) { body?.remove(); continue; }
      if (!body) {
        body = document.createElement('div');
        body.className = 'codex-reasoning-summaries';
        body.setAttribute('aria-label', '本回合已收到的思考摘要');
        header.after(body);
      }
      retained.add(body);
      const disclosure = header.querySelector('button[aria-expanded]');
      const hidden = disclosure ? disclosure.getAttribute('aria-expanded') !== 'true' : false;
      if (body.hidden !== hidden) body.hidden = hidden;
      const nodes = new Map([...body.children].map((node) => [node.dataset.summaryKey, node]));
      for (const [index, summary] of summaries.entries()) {
        let node = nodes.get(summary.key);
        if (!node) {
          node = document.createElement('div');
          node.dataset.summaryKey = summary.key;
        }
        nodes.delete(summary.key);
        if (node.textContent !== summary.text) node.textContent = summary.text;
        if (body.children[index] !== node) body.insertBefore(node, body.children[index] || null);
      }
      for (const node of nodes.values()) node.remove();
    }
    anchorCount = anchors.size;
    nativeResolved = [...anchors.values()].filter(({ id }) => id.turn).length;
    for (const body of document.querySelectorAll('.codex-reasoning-summaries')) if (!retained.has(body)) body.remove();
  };
  const fail = error => {
    failure = error;
    stopped = true;
    if (frame !== null) { view.cancelAnimationFrame(frame); frame = null; }
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    onError(error);
  };
  const refresh = () => {
    if (stopped) return;
    try {
    if (!client || client.disposed) {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      client = getClient();
      if (typeof client?.addAcceptedHistoryListener === 'function' && typeof client.addNotificationCallback === 'function') {
        unsubscribers.push(client.addAcceptedHistoryListener(refresh));
        unsubscribers.push(client.addNotificationCallback([
          'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
          'item/started', 'item/completed', 'turn/completed',
        ], refresh));
      }
    }
      if (frame === null) frame = view.requestAnimationFrame(() => {
        frame = null;
        try { render(); } catch (error) { fail(error); }
      });
    } catch (error) { fail(error); }
  };
  refresh();
  return {
    refresh,
    status: () => ({ nativeSubscribed: unsubscribers.length === 2, nativeReady: !failure && (unsubscribers.length === 2 || nativeResolved === anchorCount), error: failure?.message ?? null,
      anchorCount, nativeResolved, sections: document.querySelectorAll('.codex-reasoning-summaries').length }),
    cleanup() {
      stopped = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      for (const body of document.querySelectorAll('.codex-reasoning-summaries')) body.remove();
    },
  };
}
