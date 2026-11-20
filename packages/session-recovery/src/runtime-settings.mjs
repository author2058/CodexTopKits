export function normalizeRuntimeSettings(value) {
  const source = value?.settings || value?.threadSettings || value?.thread_settings || value?.thread || value;
  const clean = value => typeof value === 'string' ? value.trim() : '';
  const model = clean(value?.model ?? source?.model);
  const rawEffort = value?.effort ?? value?.reasoningEffort ?? value?.reasoning_effort ?? source?.effort ?? source?.reasoningEffort ?? source?.reasoning_effort ?? null;
  const rawTier = value?.serviceTier ?? value?.service_tier ?? source?.serviceTier ?? source?.service_tier ?? null;
  const effort = rawEffort === null ? null : clean(rawEffort), tier = rawTier === null ? null : clean(rawTier).toLowerCase();
  return model && model.length <= 200 && (effort === null || effort && effort.length <= 80) && (tier === null || tier && tier.length <= 80)
    ? { model, effort, serviceTier: tier === 'fast' ? 'priority' : tier } : null;
}

export function sameRuntimeSettings(left, right) {
  return Boolean(left && right && left.model === right.model && left.effort === right.effort && left.serviceTier === right.serviceTier);
}

export function createRuntimeGuard(request, initial, onStatus, normalize, same) {
  let registry = initial, stopped = false;
  const ready = new Set(), failed = new Map(), pending = new Map(), statuses = new Map();
  const protectedSettings = id => registry?.threads?.[id]?.protected === true ? normalize(registry.threads[id]) : null;
  const report = value => { if (!stopped) { statuses.set(value.threadId, value); onStatus(value); } return value; };
  const ensure = (threadId, { force = false } = {}) => {
    if (stopped) return Promise.reject(new Error('Thread runtime guard stopped.'));
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(threadId || '')) return Promise.reject(new TypeError('Invalid thread ID.'));
    const desired = protectedSettings(threadId);
    if (!desired) return Promise.resolve({ ok: true, threadId, skipped: true, stage: 'unregistered' });
    if (!force && ready.has(threadId)) return Promise.resolve(statuses.get(threadId));
    if (!force && failed.has(threadId)) return Promise.reject(failed.get(threadId));
    if (pending.has(threadId)) return pending.get(threadId);
    const work = (async () => {
      const beforeResult = await request('thread/resume', { threadId, excludeTurns: true }, 'thread_runtime_recovery_read');
      const before = normalize(beforeResult);
      if (!before) throw new Error('thread/resume did not return readable model, effort and service tier settings.');
      if (stopped || !same(desired, protectedSettings(threadId))) throw new Error('Protected settings changed during recovery; prepare the send again.');
      const changed = !same(before, desired);
      if (changed) await request('thread/settings/update', { threadId, ...desired }, 'thread_runtime_recovery_write');
      const after = changed ? normalize(await request('thread/resume', { threadId, excludeTurns: true }, 'thread_runtime_recovery_verify')) : before;
      if (!same(after, desired)) throw Object.assign(new Error('Thread runtime readback did not match its protected settings.'), { runtimeSettings: { before, desired, after } });
      if (!same(desired, protectedSettings(threadId))) throw new Error('Protected settings changed during recovery; prepare the send again.');
      if (stopped) throw new Error('Thread runtime guard stopped during recovery.');
      failed.delete(threadId); ready.add(threadId);
      return report({ ok: true, threadId, stage: changed ? 'restored' : 'verified', settings: desired, checkedAt: Date.now() });
    })().catch(error => {
      ready.delete(threadId); failed.set(threadId, error);
      report({ ok: false, threadId, stage: 'failed', name: error.name, message: error.message, stack: error.stack,
        error: { name: error.name, message: error.message, stack: error.stack, code: error.code }, ...error.runtimeSettings, checkedAt: Date.now() });
      throw error;
    }).finally(() => pending.delete(threadId));
    pending.set(threadId, work); return work;
  };
  return { ensure,
    update(next) {
      const previous = registry; registry = next;
      for (const id of new Set([...Object.keys(previous?.threads || {}), ...Object.keys(next?.threads || {})])) {
        if (previous?.threads?.[id]?.protected !== next?.threads?.[id]?.protected || !same(normalize(previous?.threads?.[id]), normalize(next?.threads?.[id]))) { ready.delete(id); failed.delete(id); statuses.delete(id); }
      }
    },
    receive(method, params) {
      const id = params.threadId || params.thread?.id;
      if (!id || !protectedSettings(id)) return;
      if (method === 'thread/settings/updated') {
        const observed = normalize(params);
        if (!observed) return;
        if (same(observed, protectedSettings(id))) { failed.delete(id); ready.add(id); report({ ok: true, threadId: id, stage: 'verified-notification', settings: observed, checkedAt: Date.now() }); return; }
        ready.delete(id);
      } else if (['thread/started', 'thread/resumed'].includes(method)) ready.delete(id);
      else return;
      void ensure(id).catch(() => { /* ensure reports and retains the original failure; no unverified send follows. */ });
    },
    status: () => [...statuses.values()], busy: () => pending.size > 0,
    cleanup() { stopped = true; },
  };
}
