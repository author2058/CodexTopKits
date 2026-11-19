export async function loadNativeCloudUnread(document, { assets, nativeHost, importModule = url => import(url) }) {
  const owner = await assets.find('conversation read state', source => source.includes('isUnread') && source.includes('forHost') && source.includes('isReady'));
  if (!owner && !nativeHost?.moduleUrl) throw new Error('Cloud unread: native read-state module changed.');
  const module = owner ? owner.load() : await importModule(nativeHost.moduleUrl);
  const readState = Object.values(module).find(value => value && typeof value.read === 'function' && typeof value.isUnread === 'function'
    && typeof value.subscribe === 'function' && typeof value.forHost === 'function' && typeof value.isReady === 'function');
  if (!readState) throw new Error('Cloud unread: native read-state export changed.');
  const root = document.getElementById('root'), key = root && Object.getOwnPropertyNames(root).find(name => name.startsWith('__reactContainer$'));
  const container = key && root[key], pending = [container?.stateNode?.current || container], seen = new Set();
  let badgeStore;
  while (pending.length && !badgeStore) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    if (typeof fiber.type === 'function' && Function.prototype.toString.call(fiber.type).includes('electron-set-badge-count')) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const values = Array.isArray(hook.memoizedState) ? hook.memoizedState : [hook.memoizedState];
        badgeStore = values.find(value => value && typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function');
        if (badgeStore) break;
      }
    }
    if (fiber.child) pending.push(fiber.child);
    if (fiber.sibling) pending.push(fiber.sibling);
  }
  if (!badgeStore) throw new Error('Cloud unread: native taskbar badge subscription changed.');
  return { readState, badgeStore, markRead: id => nativeHost.forHost('durable').markConversationAsRead(id) };
}

export function installCloudUnreadControl(readState, badgeStore, markRead, onChange) {
  let stopped = false, last = null, clearing = null;
  const status = () => {
    const badgeCount = badgeStore.getSnapshot();
    if (!Number.isInteger(badgeCount) || badgeCount < 0) throw new Error('Cloud unread: native badge count is invalid.');
    const snapshot = readState.read();
    const threadIds = snapshot?.durable ?? [];
    if (!Array.isArray(threadIds) || threadIds.some((id) => typeof id !== 'string' || !id)) {
      throw new Error('Cloud unread: native cloud read-state is invalid.');
    }
    const ready = readState.isReady() === true;
    return { ready, badgeCount, threadIds: [...new Set(threadIds)], visible: ready && badgeCount > 0 && threadIds.length > 0, busy: clearing !== null };
  };
  const refresh = () => {
    if (stopped) return;
    const next = status(), signature = JSON.stringify(next);
    if (signature !== last) { last = signature; onChange(next); }
  };
  // Both subscriptions are native notifications; no timer or sidebar dependency.
  const unsubscribeRead = readState.subscribe({ type: 'snapshot', listener: refresh });
  let unsubscribeBadge;
  try { unsubscribeBadge = badgeStore.subscribe(refresh); refresh(); }
  catch (error) { unsubscribeRead(); throw error; }
  return {
    status,
    refresh,
    clear() {
      if (clearing) return clearing;
      const current = status();
      if (!current.visible) return Promise.resolve([]);
      clearing = Promise.all(current.threadIds.map((id) => Promise.resolve().then(() => markRead(id))))
        .then(() => current.threadIds).finally(() => { clearing = null; refresh(); });
      refresh();
      return clearing;
    },
    cleanup() { stopped = true; unsubscribeRead(); unsubscribeBadge(); },
  };
}
