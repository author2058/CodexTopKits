import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createPluginHost } from './index.mjs';
import { startManager } from './manager.mjs';

const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
const statePath = directory => path.join(directory, 'runtime.json');
const describeError = (error, seen = new Set()) => {
  if (!error || typeof error !== 'object') return { message: String(error) };
  if (seen.has(error)) return { name: error.name, message: '[circular error reference]' };
  seen.add(error);
  const result = { name: error.name, message: error.message, code: error.code, stack: error.stack };
  if (error.cause !== undefined) result.cause = describeError(error.cause, seen);
  if (Array.isArray(error.errors)) result.errors = error.errors.map(item => describeError(item, seen));
  seen.delete(error);
  return result;
};

export async function startRuntime({ stateDirectory, plugins = [], onError = console.error }) {
  if (process.platform !== 'win32') throw new Error('The runtime entry currently supports Windows only.');
  if (!path.isAbsolute(stateDirectory ?? '')) throw new Error('Pass an absolute, dedicated toolkit state directory.');
  await fs.mkdir(stateDirectory, { recursive: true });
  stateDirectory = await fs.realpath(stateDirectory);
  // The OS pipe is the owner: no stale PID or lock file can block a new process.
  const key = createHash('sha256').update(stateDirectory.toLowerCase(), 'utf8').digest('hex');
  const pipe = String.raw`\\.\pipe\codex-toolkit-${key}`;
  const instanceId = randomUUID(), token = randomBytes(32).toString('hex');
  let host, manager, releasing, closing, phase = 'starting';
  const status = () => ({ version: 1, instanceId, pid: process.pid, phase, managerUrl: manager?.url, cdp: host?.cdpStatus() ?? null, health: host?.health() ?? { ok: false, plugins: [] }, languagePreference: host?.languagePreference() ?? { mode: 'auto' }, ...host?.languageEnvironment(), hostAppearance: host?.appearance() ?? null });
  const release = options => {
    if (!releasing) releasing = (async () => {
      phase = 'stopping';
      const cleanup = await Promise.allSettled([manager?.close(), host?.close(options)]);
      phase = 'stopped';
      const errors = cleanup.filter(item => item.status === 'rejected').map(item => item.reason);
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Runtime shutdown failed.', { cause: errors[0] });
    })();
    return releasing;
  };
  const close = options => {
    if (!closing) closing = (async () => {
      let failure;
      try { await release(options); } catch (error) { failure = error; }
      try { if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      catch (error) { if (failure) throw new AggregateError([failure, error], 'Runtime shutdown failed.', { cause: failure }); throw error; }
      if (failure) throw failure;
    })();
    return closing;
  };
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let packet = Buffer.alloc(0), received = false;
    socket.on('error', onError);
    socket.on('data', chunk => {
      if (received) return;
      packet = Buffer.concat([packet, chunk]);
      // This protocol accepts only an action and two fixed-length identifiers.
      if (packet.length > 1024) { received = true; socket.end('{"ok":false,"error":{"message":"Runtime command is too large."}}\n', 'utf8'); return; }
      const end = packet.indexOf(10);
      if (end < 0) return;
      received = true;
      void (async () => {
        const command = decode(packet.subarray(0, end));
        if (command.instanceId !== instanceId || command.token !== token) throw new Error('Runtime identity or access token does not match.');
        if (command.action === 'status') return socket.end(JSON.stringify({ ok: true, ...status() }) + '\n', 'utf8');
        if (command.action === 'reconnect') {
          if (!host || phase !== 'running') throw new Error('The runtime has not finished starting.');
          await host.reconnect();
          return socket.end(JSON.stringify({ ok: true, ...status() }) + '\n', 'utf8');
        }
        if (command.action === 'check') {
          if (!host || phase !== 'running') throw new Error('The runtime has not finished starting.');
          await host.check();
          return socket.end(JSON.stringify({ ok: true, ...status() }) + '\n', 'utf8');
        }
        if (command.action === 'environment') {
          if (!host || phase !== 'running') throw new Error('The runtime has not finished starting.');
          const environment = { ...host.launchEnvironment };
          for (const plugin of plugins) for (const [name, value] of Object.entries(host.getPlugin(plugin.id).launchEnvironment ?? {})) {
            if (typeof value !== 'string') throw new Error('Invalid plugin launch environment: ' + plugin.id);
            if (name in environment && environment[name] !== value) throw new Error('Conflicting plugin launch environment: ' + name);
            environment[name] = value;
          }
          return socket.end(JSON.stringify({ ok: true, ...status(), environment }) + '\n', 'utf8');
        }
        if (command.action !== 'stop') throw new Error('Unknown runtime command.');
        if (command.applicationExited !== undefined && command.applicationExited !== true) throw new Error('Invalid application exit confirmation.');
        const options = { applicationExited: command.applicationExited === true };
        let failure;
        try { await release(options); } catch (error) { failure = error; }
        const closed = close(options);
        socket.end(JSON.stringify(failure ? { ok: false, instanceId, error: describeError(failure) } : { ok: true, ...status() }) + '\n', 'utf8');
        try { await closed; } catch (error) { if (error !== failure) onError(error); }
      })().catch(error => socket.end(JSON.stringify({ ok: false, instanceId, error: describeError(error) }) + '\n', 'utf8'));
    });
  });
  server.listen(pipe);
  await once(server, 'listening');
  try {
    host = await createPluginHost({ stateDirectory, plugins });
    manager = await startManager({ host, status, token, onError });
    host.setManagementUrl(manager.url);
    phase = 'running';
    const temporary = statePath(stateDirectory) + '.' + instanceId + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ version: 1, instanceId, token, pipe, pid: process.pid, startedAt: new Date().toISOString() }) + '\n', { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, statePath(stateDirectory));
    return { status, close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { if (cleanup !== error) throw new AggregateError([error, cleanup], 'Runtime startup and cleanup failed.', { cause: error }); }
    throw error;
  }
}

export async function requestRuntime(stateDirectory, action, { applicationExited = false } = {}) {
  if (!['status', 'check', 'reconnect', 'stop', 'environment'].includes(action)) throw new Error('Unknown runtime command.');
  if (applicationExited && action !== 'stop') throw new Error('Application exit confirmation is only valid when stopping.');
  let state;
  try { state = decode(await fs.readFile(statePath(stateDirectory))); }
  catch (error) { if (action === 'status' && error.code === 'ENOENT') return { phase: 'stopped' }; throw error; }
  if (state.version !== 1 || typeof state.pipe !== 'string' || typeof state.instanceId !== 'string' || typeof state.token !== 'string') throw new Error('Invalid runtime state.');
  try {
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(state.pipe), chunks = [];
      // Requests are newline-framed; closing the writer early can lose a delayed Windows pipe reply.
      socket.on('connect', () => socket.write(JSON.stringify({ action, instanceId: state.instanceId, token: state.token, ...(applicationExited ? { applicationExited: true } : {}) }) + '\n', 'utf8'));
      socket.on('data', chunk => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('end', () => {
        try {
          const response = decode(Buffer.concat(chunks));
          if (!response.ok) throw Object.assign(new Error(response.error?.message || 'Runtime request failed.'), response.error);
          if (response.instanceId !== state.instanceId) throw new Error('Runtime response identity changed.');
          resolve(response);
        } catch (error) { reject(error); }
      });
    });
  } catch (error) {
    if (action === 'status' && ['ENOENT', 'ECONNREFUSED'].includes(error.code)) return { phase: 'stopped' };
    throw error;
  }
}
