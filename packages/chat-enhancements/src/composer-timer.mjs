import { createNativeAssetReader } from 'codex-toolkit-core/renderer';

export function composerIsWorking(timing, source) {
  return timing?.active === true && (!source || source.status === 'working' && source.completedAtMs == null);
}

// Read only the already-loaded native turn store; never resume or load history.
export function nativeComposerTiming(client, threadId, now = Date.now()) {
  const conversation = client?.getConversation(threadId);
  if (!conversation) return null;
  const turns = Object.values(conversation.turnHistory?.history?.entitiesByKey || {});
  if (!turns.length) turns.push(...(conversation.turns || []));
  const execution = client.getThreadExecutionState(threadId);
  let turn = execution?.activeTurnId ? turns.find((entry) => entry.turnId === execution.activeTurnId) : null;
  if (!turn) for (const entry of turns) {
    if (Number.isFinite(entry.turnStartedAtMs) && (!turn || entry.turnStartedAtMs > turn.turnStartedAtMs)) turn = entry;
  }
  if (!turn || !Number.isFinite(turn.turnStartedAtMs)) return null;
  const active = execution?.inProgress === true && turn.status === 'inProgress';
  const end = active ? now : Number.isFinite(turn.finalAssistantStartedAtMs) ? turn.finalAssistantStartedAtMs
    : Number.isFinite(turn.durationMs) ? turn.turnStartedAtMs + turn.durationMs : null;
  return { turnId: turn.turnId, active, startedAtMs: turn.turnStartedAtMs, elapsedMs: Number.isFinite(end) ? Math.max(0, end - turn.turnStartedAtMs) : null };
}

// New builds own the same turn state behind RPC. Refresh only on lifecycle
// notifications; the visible one-second clock never requests a conversation.
export function createRpcComposerTiming(getRpc, calculate, onChange, onError, onDiagnostic = () => {}) {
  const entries = new Map();
  let stopped = false, readSequence = 0;
  const timingFor = (threadId, entry, execution, turn) => {
    const completed = entry.completed.get(turn?.turnId);
    return calculate({ getConversation: () => ({ turns: turn ? [{ ...turn, ...completed }] : [] }),
      getThreadExecutionState: () => completed ? { ...execution, inProgress: false } : execution }, threadId);
  };
  const refresh = (threadId, reason = 'refresh') => {
    let entry = entries.get(threadId);
    if (!entry) { entry = { timing: null, turn: null, completed: new Map(), pending: null, dirty: false, error: null,
      waitingForRpc: false, lastNotification: null, lastRead: null }; entries.set(threadId, entry); }
    if (stopped || entry.error) return entry.pending;
    entry.dirty = true; entry.refreshReason = reason;
    const rpc = getRpc();
    if (!rpc) {
      if (!entry.waitingForRpc) { entry.waitingForRpc = true; onDiagnostic({ kind: 'waiting-for-rpc', threadId, reason }); }
      return entry.pending;
    }
    entry.waitingForRpc = false;
    if (entry.pending) return entry.pending;
    entry.pending = Promise.resolve().then(async () => {
      do {
        entry.dirty = false;
        const readId = ++readSequence, requestedAt = Date.now(), readReason = entry.refreshReason;
        const [execution, latestId] = await Promise.all([rpc.getThreadExecutionState(threadId), rpc.getLatestTurnId(threadId)]);
        if (stopped) return;
        // The native store returns null for a pending/unloaded composer, not an interface error.
        if (execution == null && latestId == null) {
          entry.turn = null; entry.timing = null;
          onDiagnostic({ kind: 'conversation-unavailable', threadId, readId, requestedAt, reason: readReason });
          onChange(threadId);
          continue;
        }
        if (!execution || typeof execution.inProgress !== 'boolean') throw new TypeError('Native composer execution state changed: ' + threadId);
        const turnId = execution?.activeTurnId || latestId;
        const turn = turnId ? await rpc.getTurnById(threadId, turnId) : null;
        if (turn && turn.turnId !== turnId) throw new Error('Native composer timing returned a different turn: ' + threadId);
        const timing = timingFor(threadId, entry, execution, turn);
        if (stopped) return;
        entry.lastRead = { readId, requestedAt, finishedAt: Date.now(), reason: readReason, inProgress: execution.inProgress,
          activeTurnId: execution.activeTurnId ?? null, latestTurnId: latestId ?? null, turnId: turn?.turnId ?? null,
          turnStatus: turn?.status ?? null, startedAtMs: turn?.turnStartedAtMs ?? null,
          finalAssistantStartedAtMs: turn?.finalAssistantStartedAtMs ?? null, durationMs: turn?.durationMs ?? null,
          completionObserved: entry.completed.has(turn?.turnId), active: timing?.active ?? null, published: !entry.dirty };
        onDiagnostic({ kind: 'rpc-read', threadId, ...entry.lastRead });
        if (!entry.dirty) {
          entry.turn = turn && { turnId: turn.turnId, status: turn.status, turnStartedAtMs: turn.turnStartedAtMs,
            finalAssistantStartedAtMs: turn.finalAssistantStartedAtMs, durationMs: turn.durationMs };
          entry.timing = timing; onChange(threadId);
        }
      } while (entry.dirty && !stopped);
    }).catch(error => {
      if (stopped) return;
      entry.error = error;
      onError(error, threadId);
      onDiagnostic({ kind: 'rpc-error', threadId, name: error.name, message: error.message, stack: error.stack });
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  };
  return {
    read(threadId) { if (!entries.has(threadId)) refresh(threadId, 'initial'); return entries.get(threadId)?.timing ?? null; },
    refresh,
    ready() { for (const [threadId, entry] of entries) if (entry.dirty && !entry.pending) refresh(threadId, 'rpc-ready'); },
    receive(method, params) {
      const threadId = params?.threadId || params?.thread?.id;
      if (!entries.has(threadId)) return;
      const entry = entries.get(threadId), turnId = params?.turnId || params?.turn?.id;
      if (['turn/started', 'turn/completed', 'thread/status/changed', 'thread/resumed'].includes(method)
        || method === 'item/started' && (entry.timing === null || params.item?.type === 'agentMessage' && params.item.phase === 'final_answer')) {
        entry.lastNotification = { method, turnId: turnId ?? null, observedAt: Date.now() };
        onDiagnostic({ kind: 'notification', threadId, ...entry.lastNotification });
      }
      if (method === 'turn/completed' && turnId) {
        // Completion precedes native store commits; an old RPC snapshot cannot reopen this turn.
        entry.completed.set(turnId, { ...entry.completed.get(turnId),
          ...(Number.isFinite(params.turn?.durationMs) ? { durationMs: params.turn.durationMs } : {}) });
        if (entry.turn?.turnId === turnId) {
          entry.timing = timingFor(threadId, entry, { inProgress: false }, entry.turn);
          onChange(threadId);
        }
      }
      if (['turn/started', 'turn/completed', 'thread/status/changed', 'thread/resumed'].includes(method)
        || method === 'item/started' && (entries.get(threadId).timing === null || params.item?.type === 'agentMessage' && params.item.phase === 'final_answer')) refresh(threadId, method);
    },
    status() { return { available: Boolean(getRpc()), pending: [...entries.values()].filter(entry => entry.pending).length,
      error: [...entries.values()].find(entry => entry.error)?.error.message || null,
      entries: [...entries].map(([threadId, entry]) => ({ threadId, timing: entry.timing, waitingForRpc: entry.waitingForRpc,
        pending: Boolean(entry.pending), dirty: entry.dirty, lastNotification: entry.lastNotification, lastRead: entry.lastRead,
        error: entry.error ? { name: entry.error.name, message: entry.error.message, stack: entry.error.stack } : null })) }; },
    cleanup() { stopped = true; entries.clear(); },
  };
}

// Read native timing boundaries, not React's alternating cached time labels.
export function nativeWorkedTiming(viewport, turnId, now = Date.now()) {
  const turn = [...(viewport?.querySelectorAll('[data-content-search-turn-key]') || [])]
    .find((element) => element.getAttribute('data-content-search-turn-key') === turnId);
  for (const element of turn?.querySelectorAll('span.tabular-nums') || []) {
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
    let fiber = key ? element[key] : null;
    let root = fiber;
    while (root?.return) root = root.return;
    // Bailouts can leave both alternates' return chains pointing at the current
    // root. Only membership in its actual child tree proves which is committed.
    if (root?.stateNode?.current && fiber?.alternate) {
      const candidates = [fiber, fiber.alternate];
      const pending = [root.stateNode.current];
      fiber = null;
      while (pending.length) {
        const node = pending.pop();
        if (candidates.includes(node)) { fiber = node; break; }
        if (node.child) pending.push(node.child);
        if (node.sibling) pending.push(node.sibling);
      }
    }
    for (; fiber; fiber = fiber.return) {
      const props = fiber.memoizedProps || {};
      if (Number.isFinite(props.startedAtMs) && ['working', 'worked', 'stopped', 'paused'].includes(props.status)) {
        return { status: props.status, startedAtMs: props.startedAtMs, completedAtMs: props.completedAtMs, elapsedMs: Math.max(0, (props.completedAtMs ?? now) - props.startedAtMs) };
      }
    }
  }
  return null;
}

export async function loadNativeDurationFormatter(document, { fetchModule = globalThis.fetch, importModule = (url) => import(url),
  assets = createNativeAssetReader(document, { fetchModule, importModule }) } = {}) {
  const findFormatter = (module) => Object.values(module).find((value) => typeof value === 'function'
    && value.toString().includes('underOneSecond') && value.toString().includes('trimZeroUnits')
    && value.toString().includes('Math.floor'));
  const owner = await assets.find('duration formatter', source => source.includes('underOneSecond')
    && source.includes('trimZeroUnits') && source.includes('Math.floor'));
  if (owner) {
    const formatter = findFormatter(owner.load());
    if (!formatter) throw new Error('Native duration formatter export changed.');
    return formatter;
  }
  const initialUrl = await assets.resolve('app-initial');
  if (!initialUrl) throw new Error('Native duration formatter: app-initial module reference changed.');
  let formatter = findFormatter(await importModule(initialUrl));
  if (!formatter) {
    // Newer builds export the same formatter from app-primary instead.
    const initialSource = await assets.read(initialUrl);
    const primaryName = initialSource.match(/app-primary-[A-Za-z0-9_-]+\.js/)?.[0];
    if (!primaryName) throw new Error('Native duration formatter: app-primary module reference changed.');
    formatter = findFormatter(await importModule(new URL(primaryName, initialUrl).href));
  }
  if (!formatter) throw new Error('Native duration formatter export changed.');
  return formatter;
}
