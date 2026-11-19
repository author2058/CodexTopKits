export async function createTrafficObserverRouter(initialFactory, options) {
  let factory = initialFactory, current = factory ? await factory(options) : null, switching, closed = false, lastCapture = null, activeOperations = 0, drained;
  const backlog = [];
  const deliver = item => { if (item.kind === 'record') current.record(item.value); else current.log.coverage(...item.args); };
  const call = async (method, args, { optional = false, requireDrained = false } = {}) => {
    while (switching) await switching;
    if (closed) throw new Error('Traffic observer is stopped.');
    if (!current) { if (optional) return; throw new Error('流量观察 Kit 未启用。'); }
    if (requireDrained && backlog.length) throw new Error('流量记录队列尚未写入，请检查诊断。');
    activeOperations++;
    try { return await current[method](...args); }
    finally { if (--activeOperations === 0 && drained) { const complete = drained; drained = null; complete(); } }
  };
  return {
    active: () => Boolean(current),
    record(value) {
      if (closed) return;
      if (switching || backlog.length || !current && factory) { if (['http-send', 'websocket-send', 'model-traffic'].includes(value.event)) backlog.push({ kind: 'record', value }); }
      else current?.record(value);
    },
    coverage(...args) { if (closed) return; if (switching || backlog.length || !current && factory) backlog.push({ kind: 'coverage', args }); else current?.log.coverage(...args); },
    query: filters => call('query', [filters], { requireDrained: true }),
    check: () => call('check', [], { optional: true }),
    setCapture: enabled => call('setCapture', [enabled]),
    async replace(nextFactory) {
      if (closed) throw new Error('Traffic observer is stopped.');
      if (switching) throw new Error('Traffic observer update is already in progress.');
      let unlock; switching = new Promise(resolve => { unlock = resolve; });
      const old = current, oldFactory = factory; let capture;
      let oldClosed = false, failure;
      try {
        if (activeOperations) await new Promise(resolve => { drained = resolve; });
        capture = old?.captureState() || lastCapture; lastCapture = capture;
        if (old) { await old.close(); oldClosed = true; current = null; }
        options.changed([]);
        current = nextFactory ? await nextFactory({ ...options, initialCapture: capture }) : null; factory = nextFactory;
      } catch (error) {
        failure = error;
        if (old && !oldClosed) current = null;
        else if (oldClosed && oldFactory) {
          try { current = await oldFactory({ ...options, initialCapture: capture }); factory = oldFactory; }
          catch (rollback) { failure = new AggregateError([error, rollback], 'Traffic observer update and recovery failed.', { cause: error }); }
        }
      }
      try {
        if (current && old && capture?.requested) current.log.coverage('observer-handoff', 'gap', '流量观察器更新期间 Chromium 采集可能有短暂空档；模型代理计量在切换期间排队保留。');
        else if (current && !old) current.log.coverage('observer-handoff', 'gap', '流量观察器启用前的数据未采集。');
        if (current) while (backlog.length) { deliver(backlog[0]); backlog.shift(); }
        else if (!failure && !nextFactory) backlog.length = 0;
      } catch (error) { failure = failure ? new AggregateError([failure, error], 'Traffic observer update and queued recording failed.', { cause: failure }) : error; }
      switching = null; unlock(); if (failure) throw failure;
    },
    async close() { closed = true; if (switching) await switching; if (activeOperations) await new Promise(resolve => { drained = resolve; }); await current?.close(); current = null; },
  };
}
