export function findNativeConversationStore(root, hostId = 'local') {
  const key = root && Object.getOwnPropertyNames(root).find(name => name.startsWith('__reactContainer$'));
  const pending = key ? [root[key]] : [], seen = new Set();
  while (pending.length) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    for (const value of Object.values(fiber.memoizedProps || {})) {
      if (value?.hostId === hostId && typeof value.getConversation === 'function' && typeof value.getThreadExecutionState === 'function' && !value.disposed) return value;
    }
    if (fiber.child) pending.push(fiber.child);
    if (fiber.sibling) pending.push(fiber.sibling);
  }
  return null;
}

export function findNativeUsageClient(document, findQuery) {
  const root = document.getElementById('root'), key = root && Object.getOwnPropertyNames(root).find(name => name.startsWith('__reactContainer$'));
  const pending = key ? [root[key]] : [], seen = new Set();
  while (pending.length) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    for (const candidate of [fiber.memoizedProps?.client, fiber.pendingProps?.client]) {
      if (candidate && typeof candidate.getQueryCache === 'function' && typeof candidate.getQueryData === 'function' && findQuery(candidate)) return candidate;
    }
    if (fiber.child) pending.push(fiber.child);
    if (fiber.sibling) pending.push(fiber.sibling);
  }
  return null;
}

export function nativeUsageSnapshot(client, findQuery) {
  const query = findQuery(client), body = query?.state?.data;
  const windows = [body?.rate_limit?.primary_window, body?.rate_limit?.secondary_window,
    ...(Array.isArray(body?.rate_limit?.additional_rate_limits) ? body.rate_limit.additional_rate_limits : [])]
    .filter(value => value && Number.isFinite(value.used_percent) && Number.isFinite(value.limit_window_seconds) && Number.isFinite(value.reset_at));
  windows.sort((a, b) => Math.abs(a.limit_window_seconds - 604800) - Math.abs(b.limit_window_seconds - 604800));
  const weekly = windows[0], updatedAt = Number(query?.state?.dataUpdatedAt);
  if (!weekly || Math.abs(weekly.limit_window_seconds - 604800) > 3600 || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  return { weekly: { remainingPercent: Math.max(0, Math.min(100, Math.round(100 - weekly.used_percent))), resetAt: Math.round(weekly.reset_at * 1000) }, updatedAt };
}
