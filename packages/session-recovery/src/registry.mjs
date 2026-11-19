import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRuntimeSettings } from './runtime-settings.mjs';

export function normalizeRuntimeRecord(threadId, value) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(threadId || '')) throw new TypeError('Invalid thread ID.');
  const settings = normalizeRuntimeSettings(value);
  if (!settings) throw new TypeError('A complete valid model, effort and service tier tuple is required.');
  const parentThreadId = value.parentThreadId ?? null;
  if (parentThreadId !== null && !/^[A-Za-z0-9._-]{1,200}$/.test(parentThreadId)) throw new TypeError('Invalid parent thread ID.');
  return { settings, protected: value.protected === true, kind: value.protected === true ? 'delegated-child' : null,
    parentThreadId, source: typeof value.source === 'string' ? value.source : 'explicit-registration', updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString() };
}

export async function openRuntimeRegistry(filename) {
  if (!path.isAbsolute(filename ?? '')) throw new TypeError('Runtime registry requires an absolute path.');
  let state = { version: 2, threads: {} }, writing = Promise.resolve();
  try {
    const raw = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (![1,2].includes(raw?.version) || !raw.threads || typeof raw.threads !== 'object' || Array.isArray(raw.threads)) throw new TypeError('Invalid runtime protection registry.');
    state.threads = Object.fromEntries(Object.entries(raw.threads).map(([id, value]) => [id, normalizeRuntimeRecord(id, raw.version === 1 ? { ...value, protected: false } : value)]));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const update = (threadId, transform) => {
    const operation = writing.then(async () => {
      const record = transform(state.threads[threadId]);
      if (record === state.threads[threadId]) return record;
      const next = { version: 2, threads: { ...state.threads, [threadId]: record } }, temporary = filename + '.' + randomUUID() + '.tmp';
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, filename); state = next; return record;
    });
    writing = operation.catch(() => { /* Keep the writer usable; the caller retains the original rejection. */ }); return operation;
  };
  return { snapshot: () => structuredClone(state),
    register({ threadId, parentThreadId = null, settings }) {
      if (!settings || !Object.hasOwn(settings, 'model') || !['effort','reasoningEffort','reasoning_effort'].some(key => Object.hasOwn(settings,key)) || !['serviceTier','service_tier'].some(key => Object.hasOwn(settings,key))) throw new TypeError('Explicit registration requires model, effort and service tier.');
      const record = normalizeRuntimeRecord(threadId, { settings, parentThreadId, protected: true, source: 'explicit-registration' });
      return update(threadId, () => record);
    },
    unprotect(threadId) {
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(threadId || '')) throw new TypeError('Invalid thread ID.');
      return update(threadId, previous => {
        if (!previous) throw new Error('Unknown runtime protection record: ' + threadId);
        return previous.protected ? { ...previous, protected: false, kind: null, source: 'explicit-unprotection', updatedAt: new Date().toISOString() } : previous;
      });
    },
    async close() { await writing; },
  };
}
