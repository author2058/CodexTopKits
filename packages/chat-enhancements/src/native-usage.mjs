export function isNativeRateLimitQuery(query) {
  const key = query?.queryKey;
  return Array.isArray(key) && key[0] === 'rate-limit-status'
    && (key.length === 1 || key.length === 3 && typeof key[1] === 'string' && typeof key[2] === 'string');
}

export function findNativeRateLimitQuery(client) {
  const queries = client?.getQueryCache?.().findAll({ queryKey: ['rate-limit-status'] }) || [];
  let latest = null;
  for (const query of queries) {
    if (isNativeRateLimitQuery(query) && (!latest || query.state.dataUpdatedAt > latest.state.dataUpdatedAt)) latest = query;
  }
  return latest;
}
