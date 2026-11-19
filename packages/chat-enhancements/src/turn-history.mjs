// Native disclosure identity, not English text or a synthetic DOM search key.
export function readTurnHistoryDisclosure(button, client) {
  const key = Object.getOwnPropertyNames(button).find(name => name.startsWith('__reactFiber$'));
  let disclosure = false, threadId = null, turnId = null, pagination;
  for (let fiber = key ? button[key] : null; fiber; fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (props && 'collapsedMessageCount' in props && 'workedDurationMs' in props && 'isCollapsed' in props) disclosure = true;
    if (typeof props?.conversationId === 'string') threadId ||= props.conversationId;
    if (typeof props?.turnId === 'string') turnId ||= props.turnId;
    if (typeof props?.turn?.turnId === 'string') {
      turnId ||= props.turn.turnId;
      if (props.turn.turnId === turnId) pagination ||= props.turn.itemsPagination;
    }
  }
  if (!disclosure || !threadId || !turnId) return null;
  return { threadId, turnId, expanded: button.getAttribute('aria-expanded') === 'true',
    pagination: client?.pagination?.itemPagination?.getTurnPagination?.(threadId, turnId) ?? pagination };
}

export function installTurnHistoryControl(document, getClient, readDisclosure, onError = error => console.error('[Codex Dynamic Theme] full turn history failed', error), getRpc = () => null, text = key => ({ show: '显示全部', loading: '正在加载本轮完整输出', load: '加载本轮全部历史条目' })[key]) {
  const view = document.defaultView, records = new Map(), jobs = new Map(), errors = new Map(), unsubscribers = [];
  let client = null, frame = null, stopped = false;
  const selector = 'button[aria-expanded]';
  const legacyReady = () => typeof client?.pagination?.itemPagination?.getTurnPagination === 'function'
    && typeof client?.pagination?.itemPagination?.loadTurnItems === 'function' && unsubscribers.length === 2;
  const nativeReady = () => legacyReady() || Boolean(getRpc());
  const load = async disclosure => {
    if (stopped) return false;
    refresh();
    const identity = readDisclosure(disclosure, client);
    if (!nativeReady()) throw new Error('Native per-turn history loading interfaces are unavailable.');
    if (!identity?.expanded || identity.pagination?.hasLoadedOldest !== false) return false;
    const key = identity.threadId + ':' + identity.turnId;
    if (jobs.has(key)) return jobs.get(key);
    const job = Promise.resolve().then(async () => {
      if (legacyReady()) {
        const pager = client.pagination.itemPagination;
        await pager.loadTurnItems(identity.threadId, identity.turnId, true);
        if (stopped) return false;
        if (pager.getTurnPagination(identity.threadId, identity.turnId)?.hasLoadedOldest !== true) {
          throw new Error('原生加载已返回，但该回合的前页仍未加载完整：' + identity.turnId);
        }
      } else {
        const rpc = getRpc();
        let turn = await rpc.getTurnById(identity.threadId, identity.turnId);
        if (stopped) return false;
        if (!turn || turn.turnId !== identity.turnId) throw new Error('无法读取选中回合的分页状态：' + identity.turnId);
        while (turn.itemsPagination?.hasLoadedOldest === false) {
          const before = JSON.stringify({ pagination: turn.itemsPagination, ids: turn.items.map(item => item.id) });
          await rpc.loadOlderConversationTurnsPage(identity.threadId, { turnId: identity.turnId });
          if (stopped) return false;
          turn = await rpc.getTurnById(identity.threadId, identity.turnId);
          if (stopped) return false;
          if (!turn || turn.turnId !== identity.turnId) throw new Error('原生历史加载返回了不同的回合：' + identity.turnId);
          if (JSON.stringify({ pagination: turn.itemsPagination, ids: turn.items.map(item => item.id) }) === before) {
            throw new Error('原生历史加载没有取得前一页：' + identity.turnId);
          }
        }
      }
      return true;
    });
    jobs.set(key, job);
    errors.delete(key);
    refresh();
    try { return await job; }
    catch (error) { errors.set(key, error); onError(error, identity); throw error; }
    finally { jobs.delete(key); refresh(); }
  };
  const remove = record => { record.button.remove(); record.row.classList.remove('codex-turn-history-row'); };
  const render = () => {
    if (stopped) return;
    for (const [disclosure, record] of records) {
      if (!disclosure.isConnected) { remove(record); records.delete(disclosure); }
    }
    if (!nativeReady()) return;
    for (const disclosure of document.querySelectorAll(selector)) {
      const identity = readDisclosure(disclosure, client);
      if (!identity) continue;
      const eligible = identity.expanded && identity.pagination?.hasLoadedOldest === false;
      let record = records.get(disclosure);
      if (!record && eligible) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'codex-turn-history-all';
        button.onclick = async event => { event.preventDefault(); event.stopPropagation(); await load(disclosure); };
        record = { button, row: disclosure.parentElement };
        records.set(disclosure, record);
      }
      if (!record) continue;
      if (record.row !== disclosure.parentElement) {
        record.row.classList.remove('codex-turn-history-row'); record.row = disclosure.parentElement;
      }
      if (record.button.parentElement !== record.row) record.row.appendChild(record.button);
      const key = identity.threadId + ':' + identity.turnId;
      const loading = jobs.has(key) || identity.pagination?.isLoadingOlder === true;
      record.button.hidden = !eligible;
      record.row.classList.toggle('codex-turn-history-row', eligible);
      record.button.disabled = loading;
      record.button.setAttribute('aria-busy', String(loading));
      record.button.dataset.threadId = identity.threadId; record.button.dataset.turnId = identity.turnId;
      record.button.dataset.result = errors.has(key) ? 'error' : '';
      record.error = errors.get(key)?.message; record.loading = loading;
      renderText(record);
    }
  };
  const renderText = record => {
    const label = text('show'), title = record.error || text(record.loading ? 'loading' : 'load');
    if (record.button.textContent !== label) record.button.textContent = label;
    if (record.button.title !== title) record.button.title = title;
  };
  const refresh = () => {
    if (stopped) return;
    if (!client || client.disposed) {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      client = getClient();
      if (typeof client?.addAnyConversationMetaCallback === 'function' && typeof client?.addAcceptedHistoryListener === 'function') {
        unsubscribers.push(client.addAnyConversationMetaCallback(refresh), client.addAcceptedHistoryListener(refresh));
      }
    }
    if (frame === null) frame = view.requestAnimationFrame(() => { frame = null; render(); });
  };
  const observer = new view.MutationObserver(records => {
    const containsDisclosure = node => node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector));
    if (records.some(record => record.type === 'attributes' ? record.target.matches(selector)
      : [...record.addedNodes, ...record.removedNodes].some(containsDisclosure))) refresh();
  });
  observer.observe(document.getElementById('root') || document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'],
  });
  refresh();
  return {
    refresh, load, updateText() { for (const record of records.values()) renderText(record); },
    status: () => ({ nativeReady: nativeReady(), visible: [...records.values()].filter(record => !record.button.hidden).length,
      loading: jobs.size, error: errors.values().next().value?.message || null }),
    cleanup() {
      stopped = true; observer.disconnect();
      if (frame !== null) view.cancelAnimationFrame(frame);
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      for (const record of records.values()) remove(record);
      records.clear();
    },
  };
}
