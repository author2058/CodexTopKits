import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CORE_API_VERSION } from 'codex-toolkit-core';
import { initializePage } from 'codex-toolkit-core/cdp';
import { voicePayload } from './payload.mjs';

export default function voicePlugin({ cdpPort = 'auto', externalKit = false } = {}) {
  if (CORE_API_VERSION !== 1) throw new Error('Voice Controls requires Core API 1.');
  if (typeof externalKit !== 'boolean') throw new TypeError('externalKit must be boolean.');
  return { id: 'voice', coreApiVersion: 1, cdpPort, async start(context) {
    if (typeof context.cdp?.onReconnect !== 'function') throw new Error('Voice Controls requires Core 0.3.5 or newer.');
    const page = await fs.readFile(new URL('../assets/voice-manager.html', import.meta.url), 'utf8');
    const lifetime = new AbortController(), runId = randomUUID(), sessions = new Map(), attaching = new Map(), reports = new Map(), errors = new Map(), listeners = new Set();
    let client, connecting, stopped = false, generation = 0, signature = null, revision = 0;
    const snapshot = () => ({ revision, windows: [...reports].map(([targetId, report]) => ({ targetId, ...report })), errors: [...errors.values()] });
    const publish = () => {
      if (stopped) return;
      const value = snapshot(), next = JSON.stringify({ ...value, revision: 0 });
      const ready = value.windows.filter(row => row.applicable && row.status?.ready).length;
      context.setHealth({ ok: errors.size === 0, issueCount: errors.size, message: errors.size ? [...errors.values()].map(row => row.message).join('; ') : ready ? '语音控制已连接 ' + ready + ' 个窗口。' : '语音控制已就绪，等待 Codex 窗口。',
        issues: [...errors].map(([key, error]) => ({ key, message: error.message })),
        ...(!errors.size && { messageLocales: ready ? { en: 'Voice controls connected to ' + ready + (ready === 1 ? ' window.' : ' windows.'), 'zh-Hans': '语音控制已连接 ' + ready + ' 个窗口。' } : { en: 'Voice controls are ready, waiting for Codex windows.', 'zh-Hans': '语音控制已就绪，等待 Codex 窗口。' } }) });
      if (signature === next) return;
      signature = next; value.revision = ++revision; for (const listener of listeners) listener(value);
    };
    const failed = (id, error, targetId) => {
      if (stopped || error.code === 'CDP_TARGET_CLOSED') return;
      errors.set(id, { id, targetId, name: error.name, message: error.message, stack: error.stack });
      void context.log({ event: 'voice-failed', id, targetId, name: error.name, message: error.message, stack: error.stack }).catch(error => console.error('Voice diagnostic write failed:', error)); publish();
    };
    const evaluate = async (sessionId, expression) => {
      const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    const install = (id, session) => {
      const work = (session.installing || Promise.resolve()).then(async () => {
        if (stopped) return;
        if (externalKit) {
          const report = await evaluate(session.sessionId, '(()=>{const voice=window.__CODEXTOPKITS_VOICE__;return {applicable:window===window.top&&(location.pathname==="/index.html"||location.pathname==="/"),status:voice?.status?.()||null,error:null,disabled:!voice}})()');
          if (typeof report?.applicable === 'boolean') reports.set(id, report);
          errors.delete('target:' + id); publish(); return;
        }
        if (session.scriptId) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }, session.sessionId);
        const source = voicePayload({ epoch: runId + ':' + generation });
        session.scriptId = (await client.send('Page.addScriptToEvaluateOnNewDocument', { source }, session.sessionId)).identifier;
        await evaluate(session.sessionId, source); errors.delete('target:' + id); publish();
      });
      session.installing = work.catch(() => { /* Each caller reports its original rejection. */ }); return work;
    };
    const attach = target => {
      if (stopped || target.type !== 'page' || !target.url.startsWith('app://') || sessions.has(target.targetId)) return Promise.resolve();
      if (attaching.has(target.targetId)) return attaching.get(target.targetId);
      const work = (async () => {
        const session = await initializePage(client, target.targetId, '__CDTK_VOICE_BRIDGE__'); sessions.set(target.targetId, session);
        await install(target.targetId, session);
      })().catch(error => failed('target:' + target.targetId, error, target.targetId)).finally(() => attaching.delete(target.targetId));
      attaching.set(target.targetId, work); return work;
    };
    const remove = id => { sessions.delete(id); reports.delete(id); for (const [key, row] of errors) if (row.targetId === id) errors.delete(key); publish(); };
    const receive = async message => {
      const params = message.params || {};
      if (['Target.targetCreated', 'Target.targetInfoChanged'].includes(message.method)) return attach(params.targetInfo);
      if (message.method === 'Target.targetDestroyed') return remove(params.targetId);
      if (message.method === 'Target.detachedFromTarget') { const row = [...sessions].find(([, value]) => value.sessionId === params.sessionId); if (row) remove(row[0]); return; }
      const row = [...sessions].find(([, value]) => value.sessionId === message.sessionId); if (!row) return;
      const [id, session] = row;
      if (message.method === 'Page.frameNavigated' && !params.frame.parentId) return install(id, session);
      if (message.method !== 'Runtime.bindingCalled' || params.name !== '__CDTK_VOICE_BRIDGE__') return;
      const value = JSON.parse(params.payload);
      if (typeof value.applicable !== 'boolean') throw new TypeError('Invalid voice renderer report.');
      reports.set(id, value); errors.delete('target:' + id); errors.delete('renderer:' + id);
      if (value.error) errors.set('renderer:' + id, { id: 'voice', targetId: id, ...value.error }); publish();
    };
    const connect = () => {
      if (connecting) return connecting;
      if (client && !client.closed) return Promise.all(client.targets().map(attach));
      connecting = (async () => {
        client = await context.cdp.acquire({ signal: lifetime.signal }); generation++; sessions.clear(); reports.clear(); errors.delete('cdp');
        for (const [id,error] of errors) if (error.targetId) errors.delete(id);
        client.onError = error => failed('cdp', error); client.handlers.add(receive);
        await Promise.all(client.targets().map(attach)); publish();
      })().catch(error => { if (!stopped) failed('cdp', error); throw error; }).finally(() => { connecting = null; }); return connecting;
    };
    const unsubscribeReconnect = context.cdp.onReconnect(async () => {
      await connecting;
      if (!stopped) return connect();
    });
    publish(); void connect().catch(() => { /* connect records its original failure. */ });
    const check = async (recovering = false) => {
      if (errors.size && ![...reports.values()].some(row => row.status?.active || row.status?.state?.sessionKey)) generation++;
      await connect();
      if (recovering && errors.has('cdp')) await client.send('Browser.getVersion');
      await Promise.all([...sessions].filter(([id]) => !recovering || [...errors.values()].some(error => error.targetId === id)).map(async ([id, session]) => { try { await install(id, session); await evaluate(session.sessionId, externalKit ? 'window.__CODEXTOPKITS_VOICE__?.refresh()' : 'window.__CODEX_DESKTOP_TOOLKIT_VOICE__?.refresh()'); } catch (error) { failed('target:' + id, error, id); } }));
      if (!client.closed) errors.delete('cdp'); publish(); return snapshot();
    };
    return { check, recover: () => check(true),
      management: { title: { en: 'Voice volume', 'zh-Hans': '语音音量' }, async request({ method, url }) {
        if (method === 'GET' && url.pathname === '/') return { type: 'text/html; charset=utf-8', body: page };
        if (method === 'GET' && url.pathname === '/api/state') return { body: snapshot() };
        if (method === 'GET' && url.pathname === '/api/events') return { subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); } };
        if (method === 'POST' && url.pathname === '/api/check') return { body: await check() };
        return null;
      } },
      async close() {
        stopped = true; unsubscribeReconnect(); lifetime.abort(new Error('Voice plugin stopped.')); await Promise.allSettled([connecting, ...attaching.values(), ...[...sessions.values()].map(value => value.installing)]);
        const failures = [];
        if (client && !client.closed) for (const [id, session] of sessions) {
          try {
            if (session.scriptId) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }, session.sessionId);
            if (!externalKit) await evaluate(session.sessionId, 'window.__CODEX_DESKTOP_TOOLKIT_VOICE__?.cleanup()');
            if (session.bound) await client.send('Runtime.removeBinding', { name: '__CDTK_VOICE_BRIDGE__' }, session.sessionId);
          } catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') failures.push(new Error('Voice cleanup failed for ' + id, { cause: error })); }
        }
        try { await client?.close(); } catch (error) { failures.push(error); }
        listeners.clear(); if (failures.length) throw new AggregateError(failures, 'Voice cleanup failed.', { cause: failures[0] });
      },
    };
  } };
}
