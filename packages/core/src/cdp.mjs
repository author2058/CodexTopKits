import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// Publish a page session only after all three protocol prerequisites succeed.
export async function initializePage(client, targetId, bindingName) {
  const session = await client.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await client.send('Runtime.enable', {}, session.sessionId);
    await client.send('Page.enable', {}, session.sessionId);
    await client.send('Runtime.addBinding', { name: bindingName }, session.sessionId);
    session.bound = true;
    return session;
  } catch (error) {
    if (!client.closed) {
      try { await client.send('Target.detachFromTarget', { sessionId: session.sessionId }); }
      catch (cleanup) { if (cleanup.code !== 'CDP_TARGET_CLOSED') throw new AggregateError([error, cleanup], 'CDP page initialization and cleanup failed.', { cause: error }); }
    }
    throw error;
  }
}

export async function createCdpService(requestedPorts, { onDiagnostic = () => {} } = {}) {
  const ports = [...new Set(requestedPorts.filter(value => value !== undefined && value !== 'auto'))];
  if (requestedPorts.some(value => value !== undefined && value !== 'auto' && (!Number.isInteger(value) || value < 1024 || value > 65535))) throw new Error('CDP port must be auto or an integer from 1024 to 65535.');
  if (ports.length > 1) throw new Error('Installed plugins requested different CDP ports. Configure the same port or auto.');
  let port = ports[0];
  if (!port) {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  }
  const lifetime = new AbortController(), leases = new Map(), targets = new Map(), pending = new Map(), sessionTargets = new Map(), reconnectListeners = new Map();
  let socket, connecting, recovering, timeoutRecoveryUsed = false, closed = false, stopping = false, ready = false, connectedOnce = false, nextId = 0, traceOwner = null, traceLease = null, traceState = 'idle', targetReplay = null;
  const notify = (lease, field, value) => {
    if (!lease) return;
    try { lease[field]?.(value); }
    catch (error) { console.error('CDP consumer callback failed:', error); }
  };
  const fail = error => {
    ready = false;
    const lostTargets = [...targets.keys()];
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear(); traceOwner = null; traceLease = null; traceState = 'idle'; targets.clear(); sessionTargets.clear();
    const activeLeases = [...leases.values()].filter(lease => !lease.closed);
    // Health callbacks can publish to other owners. Invalidate everyone first,
    // so those publications cannot enqueue commands on the dying connection.
    for (const lease of activeLeases) lease.closed = true;
    for (const lease of activeLeases) {
      // A lost browser invalidates every owned target report, even when the
      // browser could not send its final targetDestroyed notifications.
      for (const targetId of lostTargets) for (const handler of lease.handlers) {
        try { Promise.resolve(handler({ method: 'Target.targetDestroyed', params: { targetId }, toolkitDisconnect: true })).catch(failure => notify(lease, 'onError', failure)); }
        catch (failure) { notify(lease, 'onError', failure); }
      }
      notify(lease, 'onError', error); notify(lease, 'onClose', error);
      lease.handlers.clear(); lease.sessions.clear(); lease.closedSessions.clear();
    }
  };
  const send = (owner, method, params = {}, sessionId, timeoutMs = 8000) => {
    if (closed || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection is not open.'));
    return new Promise((resolve, reject) => {
      const id = ++nextId, startedAt = Date.now();
      const timer = setTimeout(() => {
        const item = pending.get(id), target = targets.get(item?.targetId);
        const operation = method === 'Runtime.evaluate' ? /^window\["__CODEX_DESKTOP_TOOLKIT_[A-Z_]+__"\]\??\.([A-Za-z]\w*)\(/.exec(params.expression)?.[1]
          || (params.expression === 'document.hasFocus()' ? 'document.hasFocus' : 'script') : undefined;
        const command = { id, owner, method, targetId: item?.targetId, targetType: target?.type, sessionId,
          operation, expressionChars: params.expression?.length, awaitPromise: params.awaitPromise,
          timeoutMs, elapsedMs: Date.now() - startedAt, pendingCount: pending.size, socketState: socket?.readyState,
          recovering: !!recovering, recoveryUsed: timeoutRecoveryUsed };
        pending.delete(id);
        const error = Object.assign(new Error('CDP command timed out: ' + method), { code: 'CDP_COMMAND_TIMEOUT', command });
        onDiagnostic({ event: 'cdp-command-timeout', ...command });
        reject(error);
        // A responsive transport can retain unusable sessions after resume. Rebuild
        // this CDP connection once, never retry the command or a model request.
        if (ready && !recovering && !timeoutRecoveryUsed && !stopping && !closed) {
          timeoutRecoveryUsed = true;
          const activeSocket = socket;
          fail(error); activeSocket.close();
          recovering = (async () => {
            await new Promise(resolve => setImmediate(resolve));
            await connect();
            await Promise.all([...reconnectListeners].flatMap(([owner, listeners]) => [...listeners].map(async listener => {
              try { await listener(); } catch (failure) { notify(leases.get(owner), 'onError', failure); }
            })));
          })().catch(failure => {
            if (!closed && !stopping) for (const owner of reconnectListeners.keys()) notify(leases.get(owner), 'onError', failure);
          }).finally(() => { recovering = null; });
        }
      }, timeoutMs);
      const addressedSession = sessionId || (method === 'Target.detachFromTarget' ? params.sessionId : undefined);
      pending.set(id, { owner, sessionId: addressedSession, targetId: params.targetId || sessionTargets.get(addressedSession), timer, resolve, reject });
      try { socket.send(JSON.stringify({ id, method, params, sessionId })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  };
  const updateTarget = message => {
    if (message.method === 'Target.targetDestroyed') targets.delete(message.params.targetId);
    else if (['Target.targetCreated', 'Target.targetInfoChanged'].includes(message.method)) targets.set(message.params.targetInfo.targetId, message.params.targetInfo);
  };
  const receive = event => {
    let message;
    try { message = JSON.parse(String(event.data)); }
    catch (error) { fail(error); socket.close(); return; }
    if (message.id !== undefined) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
      else item.resolve(message.result);
      return;
    }
    if (targetReplay) targetReplay.push(message); else updateTarget(message);
    if (message.method === 'Target.detachedFromTarget' || message.method === 'Target.targetDestroyed') {
      const detached = message.params.sessionId, destroyed = message.method === 'Target.targetDestroyed' ? message.params.targetId : null;
      const matches = item => destroyed ? item.targetId === destroyed : item.sessionId === detached;
      for (const [id, item] of pending) if (matches(item)) {
        clearTimeout(item.timer); pending.delete(id);
        item.reject(Object.assign(new Error('CDP target or session was closed: ' + (destroyed || detached)), { code: 'CDP_TARGET_CLOSED' }));
      }
      for (const [sessionId, targetId] of sessionTargets) if (destroyed ? targetId === destroyed : sessionId === detached) {
        sessionTargets.delete(sessionId); for (const lease of leases.values()) if (lease.sessions.delete(sessionId)) lease.closedSessions.add(sessionId);
      }
    }
    const finishedTraceOwner = message.method === 'Tracing.tracingComplete' ? traceOwner : null;
    if (finishedTraceOwner) { traceOwner = null; traceLease = null; traceState = 'idle'; }
    for (const lease of leases.values()) {
      if (lease.closed) continue;
      if (message.sessionId && !lease.sessions.has(message.sessionId)) continue;
      if (message.method?.startsWith('Tracing.') && lease.owner !== (finishedTraceOwner || traceOwner)) continue;
      for (const handler of lease.handlers) {
        try { Promise.resolve(handler(message)).catch(error => notify(lease, 'onError', error)); }
        catch (error) { notify(lease, 'onError', error); }
      }
    }
  };
  const connect = () => {
    if (closed || stopping) return Promise.reject(new Error('CDP service is closed.'));
    if (connecting) return connecting;
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    connecting = (async () => {
      // User-selected cold-start allowance; only an unopened local listener is retried.
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60000)]);
      let version;
      for (;;) {
        signal.throwIfAborted();
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, { redirect: 'error', signal });
          if (!response.ok) throw new Error('CDP discovery returned HTTP ' + response.status + '.');
          version = await response.json(); break;
        } catch (error) {
          if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) throw error;
          await delay(100, undefined, { signal });
        }
      }
      const url = new URL(version.webSocketDebuggerUrl);
      if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || Number(url.port) !== port || url.username || url.password || url.search || url.hash || !/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(url.pathname)) throw new Error('Rejected CDP endpoint outside the configured loopback browser.');
      socket = new WebSocket(url);
      const activeSocket = socket;
      let resumeAfterClose = false;
      socket.addEventListener('message', event => { if (socket === activeSocket) receive(event); });
      socket.addEventListener('close', () => {
        if (closed || socket !== activeSocket) return;
        const reconnect = (ready || resumeAfterClose) && !stopping;
        if (reconnect) timeoutRecoveryUsed = false;
        fail(Object.assign(new Error('CDP disconnected.'), { code: 'CDP_DISCONNECTED' }));
        if (reconnect) void connect().catch(error => {
          if (!closed && !stopping) for (const owner of reconnectListeners.keys()) notify(leases.get(owner), 'onError', error);
        });
      });
      await new Promise((resolve, reject) => {
        const cleanup = () => { socket.removeEventListener('open', opened); socket.removeEventListener('error', errored); signal.removeEventListener('abort', aborted); };
        const opened = () => { cleanup(); resolve(); };
        const errored = event => { cleanup(); reject(event.error || new Error('CDP WebSocket connection failed.')); };
        const aborted = () => { cleanup(); socket.close(); reject(signal.reason); };
        socket.addEventListener('open', opened, { once: true }); socket.addEventListener('error', errored, { once: true }); signal.addEventListener('abort', aborted, { once: true });
      });
      socket.addEventListener('error', event => {
        if (socket !== activeSocket) return;
        resumeAfterClose = ready && !stopping;
        fail(event.error || new Error('CDP WebSocket failed.')); activeSocket.close();
      });
      targetReplay = [];
      await send(null, 'Target.setDiscoverTargets', { discover: true });
      const snapshot = await send(null, 'Target.getTargets');
      if (!Array.isArray(snapshot.targetInfos)) throw new Error('CDP returned an invalid target directory.');
      targets.clear(); for (const info of snapshot.targetInfos) targets.set(info.targetId, info);
      const replay = targetReplay; targetReplay = null; for (const message of replay) updateTarget(message);
      ready = true;
      const resumed = connectedOnce; connectedOnce = true;
      if (resumed && !recovering && !closed && !stopping) for (const [owner, listeners] of reconnectListeners) for (const listener of listeners) {
        try { Promise.resolve(listener()).catch(error => notify(leases.get(owner), 'onError', error)); }
        catch (error) { notify(leases.get(owner), 'onError', error); }
      }
    })().catch(error => {
      const failure = error.name === 'TimeoutError' ? new Error(`CDP at 127.0.0.1:${port} did not become ready within the 60-second startup allowance.`, { cause: error }) : error;
      fail(failure); socket?.close(); throw failure;
    }).finally(() => { connecting = null; });
    return connecting;
  };
  const acquire = async (owner, { signal } = {}) => {
    signal?.throwIfAborted();
    const connected = connect();
    if (signal) await new Promise((resolve, reject) => {
      const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
      signal.addEventListener('abort', aborted, { once: true });
      connected.then(() => { signal.removeEventListener('abort', aborted); resolve(); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
      if (signal.aborted) aborted();
    });
    else await connected;
    signal?.throwIfAborted();
    if (closed || stopping) throw new Error('CDP service is closed.');
    const existing = leases.get(owner);
    if (existing && !existing.closed) return existing;
    const leaseSocket = socket;
    const lease = {
      owner, closed: false, handlers: new Set(), sessions: new Set(), closedSessions: new Set(), onError: null, onClose: null,
      get socket() { return leaseSocket; },
      get traceState() { return !lease.closed && traceLease === lease ? traceState : 'idle'; },
      targets: () => [...targets.values()],
      async send(method, params = {}, sessionId, timeoutMs) {
        if (lease.closed) throw Object.assign(new Error('CDP consumer is closed: ' + owner), { code: 'CDP_CONSUMER_CLOSED' });
        const assertOwned = id => {
          if (lease.sessions.has(id)) return;
          if (lease.closedSessions.has(id)) throw Object.assign(new Error('CDP target or session was closed: ' + id), { code: 'CDP_TARGET_CLOSED' });
          throw new Error('CDP session belongs to another consumer.');
        };
        if (sessionId) assertOwned(sessionId);
        if (method === 'Target.detachFromTarget') assertOwned(params.sessionId);
        if (method === 'Tracing.start') {
          if (traceOwner !== null) throw Object.assign(new Error('Browser Tracing is already owned by ' + traceOwner + '.'), { code: 'CDP_TRACE_OWNED' });
          traceOwner = owner; traceLease = lease; traceState = 'starting';
        } else if (method === 'Tracing.end' && traceLease !== lease) throw new Error('Cannot stop another consumer\'s browser trace.');
        if (method === 'Tracing.end') traceState = 'ending';
        try {
          const result = await send(owner, method, params, sessionId, timeoutMs);
          if (method === 'Tracing.start' && traceLease === lease && !lease.closed) traceState = 'active';
          if (method === 'Target.attachToTarget') { lease.sessions.add(result.sessionId); sessionTargets.set(result.sessionId, params.targetId); }
          if (method === 'Target.detachFromTarget') { lease.sessions.delete(params.sessionId); lease.closedSessions.add(params.sessionId); sessionTargets.delete(params.sessionId); }
          return result;
        } catch (error) {
          if (method === 'Tracing.start' && traceLease === lease) {
            // A timeout is not a negative acknowledgement. Only this session's owner may reconcile it.
            if (error.code === 'CDP_COMMAND_TIMEOUT' && !lease.closed) traceState = 'uncertain';
            else { traceOwner = null; traceLease = null; traceState = 'idle'; }
          }
          if (method === 'Tracing.end' && traceLease === lease && error.code === -32000 && error.message === 'Tracing is not started') { traceOwner = null; traceLease = null; traceState = 'idle'; }
          throw error;
        }
      },
      async close() {
        if (lease.closed) { lease.closedSessions.clear(); if (leases.get(owner) === lease) leases.delete(owner); return; }
        if (traceLease === lease) throw new Error('End the owned browser trace before releasing CDP.');
        const results = await Promise.allSettled([...lease.sessions].map(sessionId => lease.send('Target.detachFromTarget', { sessionId })));
        lease.closed = true; lease.handlers.clear(); lease.closedSessions.clear(); leases.delete(owner);
        for (const [id, item] of pending) if (item.owner === owner) { clearTimeout(item.timer); pending.delete(id); item.reject(new Error('CDP consumer closed: ' + owner)); }
        const failures = results.filter(result => result.status === 'rejected' && result.reason.code !== 'CDP_TARGET_CLOSED').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'CDP consumer session cleanup failed.');
      },
    };
    leases.set(owner, lease);
    return lease;
  };
  return {
    port,
    // Background retries preserve the one shared timeout recovery allowance.
    ensureConnected: connect,
    reconnect: () => { timeoutRecoveryUsed = false; return connect(); },
    forOwner: owner => Object.freeze({ port, acquire: options => acquire(owner, options),
      onReconnect(listener) {
        if (typeof listener !== 'function') throw new TypeError('CDP reconnect listener must be a function.');
        let listeners = reconnectListeners.get(owner); if (!listeners) reconnectListeners.set(owner, listeners = new Set());
        listeners.add(listener); return () => { listeners.delete(listener); if (!listeners.size) reconnectListeners.delete(owner); };
      },
    }),
    status: () => ({ port, connected: socket?.readyState === WebSocket.OPEN, targets: targets.size }),
    // The caller has verified that the application process has already exited.
    // An open-looking socket can otherwise keep shutdown waiting for a dead browser.
    applicationExited() {
      if (closed || stopping) return;
      stopping = true;
      const error = Object.assign(new Error('Codex exited before its CDP connection closed.'), { code: 'CDP_DISCONNECTED' });
      lifetime.abort(error); reconnectListeners.clear();
      fail(error); socket?.close();
    },
    async close() {
      if (closed) return;
      stopping = true; lifetime.abort(new Error('CDP service stopped.'));
      reconnectListeners.clear();
      const results = await Promise.allSettled([...leases.values()].map(lease => lease.close()));
      closed = true;
      socket?.close(); fail(new Error('CDP service stopped.'));
      await Promise.allSettled([connecting, recovering]);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'CDP service cleanup failed.');
    },
  };
}
