// Serialized into the renderer. Observe native calls and refs without issuing
// scrolls, replacing React components, or recording message/tool text.
export function installScrollDiagnostics(document, client, report, onError, runId) {
  if (typeof client?.addNotificationCallback !== 'function') throw new Error('Native scroll diagnostic notification interface changed.');
  const win = document.defaultView, surfaces = new Map(), unsubscribers = [];
  let stopped = false, failure = null, sequence = 0, surfaceSequence = 0, frame = null, queued = false;
  let pending = [];
  const errorInfo = error => ({ name: error.name, message: error.message, stack: error.stack });
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    for (const surface of surfaces.values()) surface.cleanup();
    surfaces.clear();
    for (const unsubscribe of unsubscribers) unsubscribe();
    pending = [];
  };
  const fail = error => {
    failure = errorInfo(error);
    try { cleanup(); } catch (cleanupError) { failure.cleanupError = errorInfo(cleanupError); }
    try { onError(error, failure); }
    catch (reportError) { console.error('Scroll diagnostic failure could not be reported:', error, reportError); }
  };
  const observe = fn => {
    if (stopped) return;
    try { return fn(); } catch (error) { fail(error); }
  };
  const emit = (kind, data) => {
    if (stopped) return;
    pending.push({ runId, sequence: ++sequence, observedAt: new Date().toISOString(), monotonicMs: win.performance.now(), kind, ...data });
    if (queued) return;
    queued = true;
    win.queueMicrotask(() => {
      queued = false;
      if (stopped) return;
      const records = pending; pending = [];
      observe(() => report(records));
    });
  };
  const hooks = fiber => {
    const refs = [];
    for (let hook = fiber?.memoizedState; hook; hook = hook.next) {
      const ref = hook.memoizedState;
      if (ref && typeof ref === 'object' && Object.hasOwn(ref, 'current')) refs.push(ref);
    }
    return refs;
  };
  const currentFiber = fiber => {
    let root = fiber;
    while (root?.return) root = root.return;
    return root?.stateNode?.current && root.stateNode.current !== root ? fiber.alternate ?? fiber : fiber;
  };
  const fiberOf = element => element?.[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
  const describeNative = element => {
    let api = null, follow = null, list = null, threadId = null;
    for (let fiber = fiberOf(element); fiber; fiber = fiber.return) {
      const value = currentFiber(fiber).memoizedProps?.value;
      if (typeof value?.getScrollElement === 'function' && value.getScrollElement() === element) { api = value; break; }
    }
    for (let fiber = fiberOf(element.querySelector('[data-turn-key]')); fiber; fiber = fiber.return) {
      const node = currentFiber(fiber), props = node.memoizedProps;
      if (props?.entries && typeof props.onLatestTurnHeightChange === 'function') list = node;
      if (props?.entries && typeof props.consumePendingLatestTurnSubmitPlacement === 'function') { follow = node; threadId = props.conversationId; break; }
    }
    const refs = hooks(follow), entries = follow?.memoizedProps.entries ?? [];
    return { api, follow, list, threadId,
      followRef: refs.find(ref => typeof ref.current?.followMode === 'string'),
      keyRef: refs.find(ref => typeof ref.current === 'string' && entries.some(entry => entry.turnKey === ref.current)),
      phaseRef: refs.find(ref => ['idle', 'prework', 'final_answer'].includes(ref.current)),
    };
  };
  const attach = element => {
    const id = ++surfaceSequence, restores = [], refRestores = new Map();
    let native = describeNative(element), signature = null, lastUnchangedCall = null, noops = 0;
    const position = () => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight,
      bottom: element.scrollHeight - element.clientHeight - element.scrollTop });
    const snapshot = () => {
      const props = currentFiber(native.follow ?? {})?.memoizedProps;
      const layouts = hooks(native.list).map(ref => ref.current).filter(value => value?.turnKeys && value?.heightsPx);
      return { surfaceId: id, threadId: native.threadId, ...position(),
        visible: element.clientHeight > 0, focused: document.hasFocus(), visibility: document.visibilityState,
        nativeDistance: native.api?.getLastScrollDistanceFromBottomPx(), genericFollow: native.api?.shouldFollowContentGrowth(),
        spacer: native.api?.getResponseSpacer()?.getHeightPx() ?? null,
        followMode: native.followRef?.current?.followMode ?? null, latestKey: native.keyRef?.current ?? null, phase: native.phaseRef?.current ?? null,
        entries: (props?.entries ?? []).slice(-4).map(entry => ({ key: entry.turnKey, turnId: entry.turnId ?? entry.turn?.turnId,
          sourceTurnId: entry.sourceTurnId, status: entry.turnStatus ?? entry.turn?.status, type: entry.type })),
        layout: layouts.at(-1) ? { keys: layouts.at(-1).turnKeys.slice(-4), heights: layouts.at(-1).heightsPx.slice(-4), totalHeight: layouts.at(-1).totalHeightPx } : null,
        rendered: [...element.querySelectorAll('[data-turn-key]')].slice(-3).map(row => {
          const rect = row.getBoundingClientRect();
          return { key: row.dataset.turnKey, top: rect.top, bottom: rect.bottom, height: rect.height };
        }),
      };
    };
    const record = (kind, data = {}) => emit(kind, { ...data, state: snapshot() });
    const tapRefs = () => {
      const next = new Map([[native.followRef, 'follow'], [native.keyRef, 'latest-key'], [native.phaseRef, 'phase']].filter(([ref]) => ref));
      for (const [ref, restore] of refRestores) if (!next.has(ref)) { restore(); refRestores.delete(ref); }
      for (const [ref, name] of next) {
        if (refRestores.has(ref)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(ref, 'current');
        if (!descriptor?.configurable || !('value' in descriptor)) throw new Error('Native scroll diagnostic ref contract changed: ' + name);
        let value = descriptor.value;
        const scalar = value => name === 'follow' ? value?.followMode : value;
        const get = () => value;
        const set = next => {
          const previous = value; value = next;
          if (scalar(previous) !== scalar(next)) observe(() => record('ref-write', { ref: name, previous: scalar(previous), next: scalar(next), stack: new Error().stack }));
        };
        Object.defineProperty(ref, 'current', { configurable: true, enumerable: descriptor.enumerable, get, set });
        refRestores.set(ref, () => { if (Object.getOwnPropertyDescriptor(ref, 'current')?.get === get) Object.defineProperty(ref, 'current', { ...descriptor, value }); });
      }
    };
    const wrap = (key, factory) => {
      const own = Object.getOwnPropertyDescriptor(element, key), original = element[key], wrapper = factory(original);
      Object.defineProperty(element, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapper });
      restores.push(() => { if (element[key] !== wrapper) return; if (own) Object.defineProperty(element, key, own); else delete element[key]; });
    };
    const call = (method, original, receiver, args) => {
      let before;
      observe(() => { before = position(); });
      const result = Reflect.apply(original, receiver, args); // Native exceptions escape unchanged.
      observe(() => {
        const options = args[0], y = typeof options === 'object' && options !== null ? options.top : args[1];
        const noRequestedMove = y === undefined || (method === 'scrollBy' ? y === 0 : y === before.top);
        const unchangedCall = before.top === element.scrollTop ? JSON.stringify([method, y, options?.behavior, before]) : null;
        if (unchangedCall !== null && (noRequestedMove || unchangedCall === lastUnchangedCall)) { noops++; return; }
        lastUnchangedCall = unchangedCall;
        record('scroll-call', { method, top: typeof y === 'number' ? y : null, behavior: typeof options === 'object' && options !== null ? options.behavior : null,
          before, noops, stack: new Error().stack });
        noops = 0;
      });
      return result;
    };
    const listeners = [];
    const listen = (type, fn) => { element.addEventListener(type, fn, { passive: true }); listeners.push(() => element.removeEventListener(type, fn)); };
    const surface = { snapshot, record, get threadId() { return native.threadId; },
      refresh() {
        native = describeNative(element); tapRefs();
        const entries = currentFiber(native.follow ?? {})?.memoizedProps?.entries ?? [];
        const next = JSON.stringify([native.threadId, native.followRef?.current?.followMode, native.keyRef?.current, native.phaseRef?.current,
          entries.slice(-4).map(entry => [entry.turnKey, entry.turnStatus ?? entry.turn?.status])]);
        if (signature !== next) { signature = next; record('state'); }
      },
      cleanup() { for (const restore of refRestores.values()) restore(); for (const restore of restores.reverse()) restore(); for (const remove of listeners) remove(); },
    };
    try {
      for (const method of ['scrollTo', 'scrollBy', 'scroll']) {
        if (typeof element[method] === 'function') wrap(method, original => function(...args) { return call(method, original, this, args); });
      }
      let owner = element;
      while (owner && !Object.getOwnPropertyDescriptor(owner, 'scrollTop')) owner = Object.getPrototypeOf(owner);
      const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'scrollTop'), own = Object.getOwnPropertyDescriptor(element, 'scrollTop');
      if (typeof descriptor?.get !== 'function' || typeof descriptor.set !== 'function') throw new Error('Native scrollTop accessor changed.');
      const get = function() { return Reflect.apply(descriptor.get, this, []); };
      const set = function(value) {
        let before;
        observe(() => { before = position(); });
        const result = Reflect.apply(descriptor.set, this, [value]);
        observe(() => { if (before.top !== element.scrollTop) record('scroll-call', { method: 'scrollTop', top: typeof value === 'number' ? value : null, before, stack: new Error().stack }); else noops++; });
        return result;
      };
      Object.defineProperty(element, 'scrollTop', { configurable: true, enumerable: descriptor.enumerable, get, set });
      restores.push(() => { if (Object.getOwnPropertyDescriptor(element, 'scrollTop')?.get !== get) return; if (own) Object.defineProperty(element, 'scrollTop', own); else delete element.scrollTop; });
      listen('scroll', () => schedule('scroll', surface));
      listen('wheel', event => observe(() => record('user-wheel', { deltaY: event.deltaY, deltaX: event.deltaX })));
      listen('pointerdown', event => { if (event.target === element) observe(() => record('scrollbar-pointer')); });
      listen('keydown', event => { if (event.target === element && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) observe(() => record('user-key', { key: event.key })); });
      surface.refresh();
      return surface;
    } catch (error) { surface.cleanup(); throw error; }
  };
  const refresh = () => observe(() => {
    const next = new Set(document.querySelectorAll('.thread-scroll-container'));
    for (const [element, surface] of surfaces) if (!next.has(element)) { surface.record('surface-detached'); surface.cleanup(); surfaces.delete(element); }
    for (const element of next) {
      if (!surfaces.has(element)) surfaces.set(element, attach(element));
      else surfaces.get(element).refresh();
    }
  });
  const reasons = new Map();
  const schedule = (reason, surface) => {
    if (stopped) return;
    if (!reasons.has(surface)) reasons.set(surface, new Set());
    reasons.get(surface).add(reason);
    if (frame !== null) return;
    frame = win.requestAnimationFrame(() => observe(() => {
      frame = null; refresh();
      const requests = [...reasons]; reasons.clear();
      for (const [surface, sources] of requests) if ([...surfaces.values()].includes(surface)) surface.record('frame', { reasons: [...sources] });
    }));
  };
  try {
    unsubscribers.push(client.addNotificationCallback(['turn/started', 'turn/completed', 'thread/status/changed', 'item/started', 'item/completed'], notification => observe(() => {
      const { method, params = {} } = notification;
      if (method.startsWith('item/') && params.item?.type !== 'agentMessage') return;
      const threadId = params.threadId;
      for (const surface of surfaces.values()) if (surface.threadId === threadId) {
        surface.record('notification', { method, threadId, turnId: params.turnId ?? params.turn?.id ?? null,
          status: params.turn?.status ?? params.status?.type ?? null, itemId: params.item?.id ?? null });
        schedule(method, surface);
      }
    })));
    emit('started'); refresh();
  } catch (error) { cleanup(); throw error; }
  return { refresh, cleanup, snapshot: () => [...surfaces.values()].map(surface => surface.snapshot()),
    status: () => ({ enabled: !stopped, failure, runId, sequence, surfaces: surfaces.size, scheduled: frame !== null }) };
}
