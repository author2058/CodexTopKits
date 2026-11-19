export function createTransformRouter(initial) {
  let transform = initial, switching, drained, inFlight = 0;
  const wait = async (pending, signal) => {
    if (!signal) return pending;
    signal.throwIfAborted(); let abort;
    try {
      await Promise.race([pending, new Promise((_, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  };
  return {
    async apply(data, context) {
      while (switching) await wait(switching, context.signal);
      context.signal?.throwIfAborted(); inFlight++;
      try { return await transform(data, context); }
      finally { if (--inFlight === 0 && drained) { const complete = drained; drained = null; complete(); } }
    },
    async replace(factory) {
      if (switching) throw new Error('Image transform update is already in progress.');
      let unlock; switching = new Promise(resolve => { unlock = resolve; });
      try {
        if (inFlight) await new Promise(resolve => { drained = resolve; });
        await transform.drain?.();
        const next = await factory(); if (typeof next !== 'function') throw new TypeError('Image transform backend returned no transform.');
        transform = next;
      } finally { switching = null; unlock(); }
    },
  };
}
