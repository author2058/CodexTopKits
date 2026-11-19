// Serialized into the renderer. Preserve a logical row across native key/cache
// replacement, not the temporarily clamped scrollTop of the replacement list.
export function scrollHandoffCorrection(previous, entries, layouts, distance, requested, padding, bottomInset = padding) {
  const old = previous?.entries, before = previous?.layout;
  let anchor = null;
  const skip = reason => ({ reason, distance, requested, ...(anchor ? { anchor } : {}) });
  if (!old || !before) return skip('no-baseline');
  if (old.length !== before.turnKeys.length || old.some((entry, index) => entry.turnKey !== before.turnKeys[index])) return skip('baseline-layout-mismatch');
  if (old.length === entries.length && old.every((entry, index) => entry.turnKey === entries[index].turnKey)) return skip('keys-unchanged');
  if (entries.length > old.length && old.every((entry, index) => entry.turnKey === entries[index].turnKey)) return skip('new-rows-appended');
  const id = entry => entry?.turnId ?? entry?.turn?.turnId;
  const latestBefore = old.at(-1), latestAfter = entries.at(-1);
  if ([latestBefore, latestAfter].some(entry => entry?.turnKey?.startsWith('pending-user-message:'))
    || typeof id(latestBefore) === 'string' && typeof id(latestAfter) === 'string' && id(latestBefore) !== id(latestAfter)) return skip('native-submit-placement');
  const baselineDistance = previous.distance ?? distance, baselineInset = previous.bottomInset ?? previous.padding ?? padding;
  const viewport = previous.viewportHeight;
  if (![baselineDistance, baselineInset, viewport, before.totalHeightPx, bottomInset].every(Number.isFinite)) return skip('baseline-geometry-missing');
  const top = before.totalHeightPx - (baselineDistance - baselineInset) - viewport;
  const index = before.heightsPx.findIndex((height, index) => height > 0 && before.totalHeightPx - before.bottomOffsetsPx[index] > top);
  const turnId = index < 0 ? null : id(old[index]);
  if (typeof turnId !== 'string') return skip('anchor-missing');
  const matches = entries.flatMap((entry, index) => id(entry) === turnId ? [index] : []);
  if (!matches.length) return skip('anchor-removed');
  if (matches.length !== 1 || old.filter(entry => id(entry) === turnId).length !== 1) return skip('repeated-transcript-turn');
  const nextIndex = matches[0];
  anchor = { turnId, previousKey: old[index].turnKey, key: entries[nextIndex].turnKey, previousIndex: index, index: nextIndex };
  // Other rows may enter/leave the native history window. Only this unique
  // reading anchor must survive; an array index is not its identity.
  const current = layouts.find(layout => layout.turnKeys.length === entries.length
    && layout.turnKeys.every((key, index) => key === entries[index].turnKey));
  if (!current) return skip('current-layout-missing');
  const belowBefore = before.bottomOffsetsPx[index] + before.heightsPx[index];
  const belowAfter = current.bottomOffsetsPx[nextIndex] + current.heightsPx[nextIndex];
  if (![belowBefore, belowAfter].every(Number.isFinite)) return skip('anchor-geometry-missing');
  const preserved = previous.followBottom ? 0 : Math.max(0, baselineDistance + belowAfter - belowBefore + bottomInset - baselineInset);
  return { reason: preserved === requested ? 'anchor-already-preserved' : 'preserve-logical-anchor',
    distance: preserved, requested, baselineDistance, nativeDistance: distance,
    previousTotal: before.totalHeightPx, currentTotal: current.totalHeightPx, baselineInset, bottomInset,
    anchor: { ...anchor, previousHeight: before.heightsPx[index], height: current.heightsPx[nextIndex], belowBefore, belowAfter } };
}

export function installScrollHandoffRepair(document, correction, report, onError) {
  const surfaces = new Map(), win = document.defaultView;
  if (typeof win?.requestAnimationFrame !== 'function' || typeof win.cancelAnimationFrame !== 'function') throw new Error('Native scroll handoff frame scheduler changed.');
  const runId = new Date().toISOString();
  let stopped = false, failure = null, corrected = 0, decisions = 0, lastDecision = null, retainedWithoutController = 0;
  const currentFiber = fiber => {
    let root = fiber;
    while (root?.return) root = root.return;
    return root?.stateNode?.current && root.stateNode.current !== root ? fiber.alternate ?? fiber : fiber;
  };
  const fiberOf = element => element?.[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
  const describe = element => {
    let api = null, list = null, threadId = null;
    for (let fiber = fiberOf(element); fiber; fiber = fiber.return) {
      const value = currentFiber(fiber).memoizedProps?.value;
      if (typeof value?.getScrollElement === 'function' && value.getScrollElement() === element) { api = value; break; }
    }
    // Retained transcript/placeholder rows can precede the virtualized list.
    // They are not evidence that the list's native layout contract disappeared.
    const rows = element.querySelectorAll('[data-turn-key]');
    for (const row of rows) {
      for (let fiber = fiberOf(row); fiber; fiber = fiber.return) {
        const node = currentFiber(fiber), props = node.memoizedProps;
        if (Array.isArray(props?.entries) && typeof props.onLatestTurnHeightChange === 'function') list = node;
        if (Array.isArray(props?.entries) && typeof props.consumePendingLatestTurnSubmitPlacement === 'function') { threadId = props.conversationId; break; }
      }
      if (list && threadId) break;
    }
    const layouts = [];
    let root = null;
    for (let hook = list?.memoizedState; hook; hook = hook.next) {
      const value = hook.memoizedState?.current;
      if (value?.turnKeys && value?.heightsPx && value?.bottomOffsetsPx && !layouts.includes(value)) layouts.push(value);
      if (value?.nodeType === 1) root = value;
    }
    return { api, list, root, threadId, layouts, entries: list?.memoizedProps.entries ?? [] };
  };
  const cleanup = () => {
    stopped = true;
    for (const surface of surfaces.values()) surface.cleanup();
    surfaces.clear();
  };
  const fail = error => {
    failure = { name: error.name, message: error.message, stack: error.stack, ...(error.context ? { context: error.context } : {}) };
    try { cleanup(); } catch (cleanupError) { failure.cleanupError = { name: cleanupError.name, message: cleanupError.message, stack: cleanupError.stack }; }
    onError(error, failure);
  };
  const observe = fn => {
    if (stopped) return;
    try { return fn(); } catch (error) { fail(error); }
  };
  const emit = record => {
    const entry = { runId, sequence: ++decisions, observedAt: new Date().toISOString(), ...record };
    report(entry); lastDecision = entry;
  };
  const attach = element => {
    let previous = null, unsubscribe = null, subscribedApi = null, lastTransition = null, pendingKeys = null, frame = null, frameInput = null, applying = false;
    const listeners = [];
    let restoreApi = [], nativeCompensate = null;
    const position = () => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight });
    const cancelFrame = () => { if (frame !== null) win.cancelAnimationFrame(frame); frame = null; };
    const release = () => { cancelFrame(); previous = null; lastTransition = null; pendingKeys = null; frameInput = null; };
    const readBottomInset = (model, layout) => {
      const outsideHeight = element.scrollHeight - layout.totalHeightPx;
      if (previous?.root === model.root && previous.outsideHeight === outsideHeight) return previous.bottomInset;
      if (!model.root || !element.firstElementChild) throw new Error('Native scroll handoff list geometry interface changed.');
      const rect = model.root.getBoundingClientRect(), content = element.firstElementChild.getBoundingClientRect();
      if (rect.height <= 0) throw new Error('Native scroll handoff visible list has no measurable height.');
      return (content.bottom - rect.bottom) * layout.totalHeightPx / rect.height;
    };
    const read = () => {
      const model = describe(element);
      const layout = model.layouts.find(value => value.turnKeys.length === model.entries.length
        && value.turnKeys.every((key, index) => key === model.entries[index].turnKey));
      const bottomInset = layout && element.clientHeight > 0 ? readBottomInset(model, layout) : previous?.bottomInset;
      const before = position();
      return { model, layout, bottomInset, before, actual: before.height - before.client - before.top };
    };
    // Both entry points use this decision and the same baseline owner.
    const decide = (snapshot, requested) => {
      const { model, layout, bottomInset, before } = snapshot;
      if (before.client <= 0 || !model.api) return null;
      const keyChanged = previous?.threadId === model.threadId && (model.entries.length !== previous.entries.length
        || model.entries.some((entry, index) => entry.turnKey !== previous.entries[index]?.turnKey));
      if (!keyChanged) return null;
      return correction(previous, model.entries, model.layouts, model.api.getLastScrollDistanceFromBottomPx(), requested,
        model.list.memoizedProps.getBottomScrollPaddingPx?.() ?? 0, layout ? bottomInset : previous.bottomInset);
    };
    const adopt = snapshot => {
      const { model, layout, bottomInset, before } = snapshot;
      if (!layout || before.client <= 0 || !model.api) return;
      const distance = model.api.getLastScrollDistanceFromBottomPx();
      pendingKeys = null; frameInput = null;
      previous = { threadId: model.threadId, entries: model.entries, layout, distance,
        bottomInset, root: model.root, outsideHeight: before.height - layout.totalHeightPx,
        padding: model.list.memoizedProps.getBottomScrollPaddingPx?.() ?? 0, viewportHeight: before.client,
        // Bottom anchoring across a cache handoff is distinct from the native
        // content-growth flag, which is false during response-spacer placement.
        followBottom: distance <= 24 };
    };
    const logDecision = (snapshot, match, source) => {
      const { model, before } = snapshot;
      const record = { kind: match.reason === 'preserve-logical-anchor' ? 'scroll-handoff-corrected' : 'scroll-handoff-decision',
        threadId: model.threadId, ...match, source, previousCount: previous?.entries.length, currentCount: model.entries.length,
        before, stack: new Error().stack };
      const signature = JSON.stringify([model.threadId, model.entries.map(entry => entry.turnKey), source, match.reason, match.requested, match.distance]);
      if (signature !== lastTransition) { emit(record); lastTransition = signature; }
    };
    const inputOf = snapshot => [snapshot.model.entries, snapshot.layout, snapshot.before.top, snapshot.before.height, snapshot.before.client, snapshot.bottomInset];
    const schedule = snapshot => {
      const input = inputOf(snapshot);
      if (frameInput?.every((value, index) => value === input[index])) return;
      frameInput = input;
      if (frame === null) frame = win.requestAnimationFrame(() => {
        frame = null;
        observe(() => {
          const current = read(), match = decide(current, current.actual);
          if (!match?.anchor) { capture(); return; }
          if (!['preserve-logical-anchor', 'anchor-already-preserved'].includes(match.reason)) return;
          logDecision(current, match, 'layout-frame');
          if (stopped) return;
          if (match.reason === 'anchor-already-preserved') { adopt(current); return; }
          invoke(current, match, () => Reflect.apply(nativeCompensate, current.model.api, [match.distance]), 'layout-frame');
        });
      });
    };
    const retain = (snapshot, match) => {
      const { model, before } = snapshot;
      const keys = JSON.stringify(model.entries.map(entry => entry.turnKey));
      if (pendingKeys !== keys) {
        emit({ kind: 'scroll-handoff-transition', reason: 'retain-pre-handoff-baseline', threadId: model.threadId,
          baselineDistance: previous.distance, previousTotal: previous.layout.totalHeightPx,
          previousCount: previous.entries.length, currentCount: model.entries.length, anchor: match.anchor, matchReason: match.reason,
          nativeDistance: model.api.getLastScrollDistanceFromBottomPx(), before,
          entries: model.entries.slice(-4).map(entry => ({ key: entry.turnKey, turnId: entry.turnId ?? entry.turn?.turnId })) });
        pendingKeys = keys;
      }
      schedule(snapshot);
    };
    const capture = () => observe(() => {
      if (applying) return;
      const snapshot = read(), match = decide(snapshot, snapshot.actual);
      if (match?.anchor) { retain(snapshot, match); return; }
      if (match) {
        const { model, layout } = snapshot;
        emit({ kind: 'scroll-handoff-decision',
          threadId: model.threadId, reason: 'reading-baseline-rebased', previousCount: previous.entries.length, currentCount: model.entries.length,
          matchReason: match.reason, previousTotal: previous.layout.totalHeightPx, currentTotal: layout?.totalHeightPx, distance: snapshot.actual,
          entries: model.entries.slice(-4).map(entry => ({ key: entry.turnKey, turnId: entry.turnId ?? entry.turn?.turnId })) });
      }
      cancelFrame(); adopt(snapshot);
    });
    const invoke = (snapshot, match, operation, source) => {
      cancelFrame();
      applying = true;
      let result;
      try { result = operation(); } finally { applying = false; } // Native errors retain their identity.
      observe(() => {
        const after = read(), verification = decide(after, after.actual);
        const expected = verification?.anchor ? verification.distance : match.distance;
        const unrounded = after.model.api.getUnroundedScrollDistanceFromBottomPx(after.actual);
        const settled = Number.isFinite(expected) && Math.abs(unrounded - expected) <= 1 / (win.devicePixelRatio || 1);
        if (match.reason === 'preserve-logical-anchor') corrected++;
        emit({ kind: 'scroll-handoff-result', reason: settled ? 'anchor-restored' : 'native-position-pending', threadId: snapshot.model.threadId,
          source, requested: match.requested, appliedDistance: match.distance, expectedDistance: expected,
          actualDistance: after.actual, nativeDistance: after.model.api.getLastScrollDistanceFromBottomPx(), settled, after: after.before, anchor: match.anchor });
        // Never let this write schedule itself again. A changed native layout or
        // viewport can schedule the next attempt; an unchanged page stays idle.
        frameInput = inputOf(after);
        if (settled) adopt(after);
      });
      return result;
    };
    const compensate = function(original, args) {
      let snapshot, match;
      observe(() => {
        snapshot = read(); match = decide(snapshot, args[0]);
        if (match) logDecision(snapshot, match, 'native-compensation');
        if (match && !match.anchor) release();
      });
      if (!stopped && match?.anchor && ['preserve-logical-anchor', 'anchor-already-preserved'].includes(match.reason)) {
        return invoke(snapshot, match, () => Reflect.apply(original, this, [match.distance, ...args.slice(1)]), 'native-compensation');
      }
      return Reflect.apply(original, this, args);
    };
    const bindApi = api => {
      for (const name of ['getUnroundedScrollDistanceFromBottomPx', 'compensateScrollToDistanceFromBottomPx', 'scrollToDistanceFromBottomPx', 'scrollToBottom']) {
        if (typeof api[name] !== 'function') throw new Error('Native scroll handoff interface changed: ' + name);
      }
      for (const name of ['compensateScrollToDistanceFromBottomPx', 'scrollToDistanceFromBottomPx', 'scrollToBottom']) {
        const descriptor = Object.getOwnPropertyDescriptor(api, name), original = api[name];
        if (!descriptor || !descriptor.configurable && !descriptor.writable) throw new Error('Native scroll handoff method is not replaceable: ' + name);
        if (name === 'compensateScrollToDistanceFromBottomPx') nativeCompensate = original;
        const wrapper = name === 'compensateScrollToDistanceFromBottomPx' ? function(...args) {
          return this === api ? Reflect.apply(compensate, this, [original, args]) : Reflect.apply(original, this, args);
        } : function(...args) {
          observe(() => {
            if (pendingKeys !== null) emit({ kind: 'scroll-handoff-decision', reason: 'explicit-navigation', threadId: previous?.threadId });
            release();
          });
          return Reflect.apply(original, this, args);
        };
        Object.defineProperty(api, name, { ...descriptor, value: wrapper });
        restoreApi.push(() => { if (api[name] === wrapper) Object.defineProperty(api, name, descriptor); });
      }
    };
    const surface = {
      refresh() {
        const model = describe(element);
        if (element.querySelector('[data-turn-key]') && (!model.api || !model.list || model.layouts.length === 0)) {
          throw Object.assign(new Error('Native scroll handoff layout interface changed.'), { context: {
            api: Boolean(model.api), list: Boolean(model.list), layouts: model.layouts.length,
            entries: model.entries.length, threadId: model.threadId,
          } });
        }
        if (model.api && model.api !== subscribedApi) {
          if (typeof model.api.addScrollListener !== 'function') throw new Error('Native scroll handoff subscription changed.');
          unsubscribe?.(); for (const restore of restoreApi.reverse()) restore(); restoreApi = [];
          subscribedApi = model.api; bindApi(model.api);
          unsubscribe = model.api.addScrollListener(capture);
        }
        capture();
      },
      cleanup() {
        cancelFrame();
        unsubscribe?.();
        for (const remove of listeners) remove();
        for (const restore of restoreApi.reverse()) restore(); restoreApi = [];
      },
      get scheduled() { return frame !== null; },
    };
    try {
      // User intent supersedes an unfinished identity handoff immediately.
      for (const type of ['wheel', 'pointerdown', 'keydown']) {
        const listener = event => observe(() => {
          if (type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
          if (pendingKeys !== null) emit({ kind: 'scroll-handoff-decision', reason: 'user-scroll-cancelled-handoff', threadId: previous?.threadId });
          release();
        });
        element.addEventListener(type, listener, { passive: true });
        listeners.push(() => element.removeEventListener(type, listener));
      }
      surface.refresh();
      if (stopped) { surface.cleanup(); return null; }
      return surface;
    } catch (error) { surface.cleanup(); throw error; }
  };
  const refresh = () => observe(() => {
    const mounted = [...document.querySelectorAll('.thread-scroll-container')];
    const next = new Set(mounted.filter(element => element.clientHeight > 0 || describe(element).api));
    const retained = mounted.length - next.size;
    if (retained !== retainedWithoutController) {
      emit({ kind: 'scroll-handoff-decision', reason: 'retained-viewport-without-native-owner', count: retained });
      retainedWithoutController = retained;
    }
    for (const [element, surface] of surfaces) if (!next.has(element)) { surface.cleanup(); surfaces.delete(element); }
    for (const element of next) {
      if (stopped) break;
      if (!surfaces.has(element)) { const surface = attach(element); if (surface) surfaces.set(element, surface); }
      else surfaces.get(element).refresh();
    }
  });
  refresh();
  return { refresh, cleanup, status: () => ({ enabled: !stopped, failure, surfaces: surfaces.size, retainedWithoutController, corrected, decisions,
    scheduled: [...surfaces.values()].filter(surface => surface.scheduled).length,
    lastDecision: lastDecision ? { observedAt: lastDecision.observedAt, reason: lastDecision.reason, threadId: lastDecision.threadId } : null }) };
}
