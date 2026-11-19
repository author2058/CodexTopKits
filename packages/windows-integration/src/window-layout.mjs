import fs from 'node:fs/promises';

const identifier = /^[A-Za-z0-9._-]{1,200}$/;

export function windowRoute(taskKey) {
  const separator = typeof taskKey === 'string' ? taskKey.indexOf(':') : -1;
  const host = taskKey?.slice(0, separator), thread = taskKey?.slice(separator + 1);
  if (separator < 1 || !identifier.test(host) || !identifier.test(thread)) throw new TypeError('Invalid saved conversation identity.');
  return `/local/${encodeURIComponent(thread)}` + (host === 'local' ? '' : `?hostId=${encodeURIComponent(host)}`);
}

export function validateWindowPlacement(value) {
  const normal = value?.normal;
  if (!normal || !['left', 'top', 'right', 'bottom'].every(key => Number.isSafeInteger(normal[key]))
    || normal.right <= normal.left || normal.bottom <= normal.top || typeof value.maximized !== 'boolean') {
    throw new TypeError('Invalid saved window placement.');
  }
  return { normal: { left: normal.left, top: normal.top, right: normal.right, bottom: normal.bottom },
    maximized: value.maximized, monitor: typeof value.monitor === 'string' ? value.monitor : null,
    dpi: Number.isFinite(value.dpi) && value.dpi > 0 ? value.dpi : null };
}

export async function readWindowLayout(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(text);
  if (value?.version !== 1 || !identifier.test(value.browserIdentity) || !Array.isArray(value.windows)) throw new TypeError('Unsupported window layout file.');
  for (const entry of value.windows) {
    windowRoute(entry.taskKey);
    validateWindowPlacement(entry.placement);
  }
  return value;
}

export async function writeWindowLayout(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

export class WindowRestoreCancelled extends Error {
  constructor(message) { super(message); this.name = 'WindowRestoreCancelled'; }
}

export function waitForWindowLayout(waiters, check, label, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer); waiters.delete(test); signal?.removeEventListener('abort', test);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Window restoration waited 60 seconds for ' + label)), 60000);
    const test = () => {
      try { signal?.throwIfAborted(); const value = check(); if (value) finish(null, value); }
      catch (error) { finish(error); }
    };
    signal?.addEventListener('abort', test, { once: true }); waiters.add(test); test();
  });
}

// initialRoute identifies a window only while its first page is loading. Once
// the renderer has reported a conversation, its URL is not a navigation source.
export function windowRestoreCandidate(target, context) {
  if (typeof target?.url !== 'string') return null;
  const url = new URL(target.url);
  if (url.pathname !== '/index.html') return null;
  const route = url.searchParams.get('initialRoute');
  if (route && !route.startsWith('/local/')) return null;
  const draft = key => !key || /^(?:local:)?client-new-thread:/.test(key);
  let pendingTaskKey = null;
  if (!context?.conversationResolved && route?.startsWith('/local/')) {
    const pending = new URL(route, 'http://localhost');
    pendingTaskKey = `${pending.searchParams.get('hostId') || 'local'}:${decodeURIComponent(pending.pathname.slice(7))}`;
    windowRoute(pendingTaskKey);
  }
  return { targetId: target.id, ready: context?.isMain === true,
    taskKey: draft(context?.taskKey) ? null : context.taskKey,
    pendingTaskKey, title: context?.taskTitle ?? null };
}

// Each saved slot claims at most one live window, even when a conversation was
// deliberately open twice. Never assign a window by its position in EnumWindows.
export function planWindowRestore(saved, live) {
  const available = new Map(live.map(window => [window.targetId, window]));
  const plan = saved.map(entry => {
    const match = [...available.values()].find(window => window.taskKey === entry.taskKey || (!window.taskKey && window.pendingTaskKey === entry.taskKey));
    if (match) available.delete(match.targetId);
    return { entry, targetId: match?.targetId ?? null };
  });
  // Reuse the native startup window only when it has no conversation. A window
  // already showing an unrelated chat belongs to the user and is left alone.
  for (const slot of plan) {
    if (slot.targetId) continue;
    const blank = [...available.values()].find(window => window.ready !== false && !window.taskKey && !window.pendingTaskKey);
    if (blank) { available.delete(blank.targetId); slot.targetId = blank.targetId; slot.navigate = true; }
  }
  return plan;
}

export async function restoreWindowLayout(saved, { list, open, navigate, wait, ready, place, order, signal, step = () => {} }) {
  const claimed = new Set(), restored = [];
  const check = () => signal?.throwIfAborted();
  for (const [index, entry] of saved.entries()) {
    check();
    let slot;
    for (;;) {
      const live = (await list()).filter(window => !claimed.has(window.targetId));
      check();
      slot = planWindowRestore(saved.slice(index), live)[0];
      if (slot.targetId) break;
      const loading = live.find(window => window.ready === false && !window.taskKey && !window.pendingTaskKey);
      if (!loading) break;
      await step({ phase: 'waiting-for-startup-window', index, targetId: loading.targetId });
      await ready(loading.targetId);
      check();
    }
    await step({ phase: slot.targetId ? (slot.navigate ? 'navigate' : 'adopt') : 'open', index, taskKey: entry.taskKey, targetId: slot.targetId });
    check();
    if (!slot.targetId) slot.targetId = await open(windowRoute(entry.taskKey), entry.taskKey);
    else if (slot.navigate) await navigate(slot.targetId, windowRoute(entry.taskKey));
    check();
    claimed.add(slot.targetId);
    await step({ phase: 'waiting-for-conversation', index, taskKey: entry.taskKey, targetId: slot.targetId });
    await wait(slot.targetId, entry.taskKey);
    check();
    const placement = await place(slot.targetId, entry.placement);
    check();
    await order(slot.targetId, index);
    restored.push({ taskKey: entry.taskKey, targetId: slot.targetId, placement });
    await step({ phase: 'placed', index, ...restored.at(-1) });
  }
  return restored;
}

// Persistence is independent of ephemeral target/HWND mappings. A controller
// reload in the same browser session only resumes observation, never placement.
export class WindowLayoutStore {
  constructor({ file, browserIdentity, document = null, write = writeWindowLayout, now = Date.now }) {
    this.file = file; this.browserIdentity = browserIdentity; this.document = document;
    this.write = write; this.now = now; this.tail = Promise.resolve();
    this.pending = document?.windows?.length > 0 && document.browserIdentity !== browserIdentity
      && document.restore?.browserIdentity !== browserIdentity;
    this.restoring = false;
    // A previous attempt owns only that attempt, not the rest of this app
    // session. Reloading the controller resumes observation without replay.
    this.failed = false;
    this.resumedAttempt = document?.restore?.browserIdentity === browserIdentity && ['started', 'failed'].includes(document.restore.status);
    this.signature = document?.browserIdentity === browserIdentity ? JSON.stringify(document.windows) : null;
  }

  save(document) {
    const operation = this.tail.then(async () => { await this.write(this.file, document); this.document = document; });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async restore(adapters) {
    if (!this.pending || this.restoring) return null;
    this.pending = false; this.restoring = true;
    const saved = this.document;
    try {
      await this.save({ ...saved, restore: { browserIdentity: this.browserIdentity, status: 'started', at: new Date(this.now()).toISOString(), sourceWindows: saved.windows } });
      const result = await restoreWindowLayout(saved.windows, adapters);
      await this.save({ ...this.document, browserIdentity: this.browserIdentity,
        restore: { ...this.document.restore, status: 'completed', at: new Date(this.now()).toISOString() } });
      return result;
    } catch (error) {
      this.failed = !(error instanceof WindowRestoreCancelled);
      try { await this.save({ ...saved, restore: { browserIdentity: this.browserIdentity, status: this.failed ? 'failed' : 'cancelled', at: new Date(this.now()).toISOString(), message: error.message, sourceWindows: saved.windows } }); }
      catch (saveError) { throw new AggregateError([error, saveError], 'Window restoration and saving its failure both failed.', { cause: error }); }
      throw error;
    } finally { this.restoring = false; }
  }

  async capture(windows) {
    if (this.pending || this.restoring || this.failed || !windows.length) return false;
    for (const entry of windows) { windowRoute(entry.taskKey); validateWindowPlacement(entry.placement); }
    const signature = JSON.stringify(windows);
    if (signature === this.signature) return false;
    await this.save({ version: 1, browserIdentity: this.browserIdentity, updatedAt: new Date(this.now()).toISOString(),
      restore: this.resumedAttempt ? { ...this.document.restore, status: 'observing', at: new Date(this.now()).toISOString(),
        sourceWindows: this.document.restore.sourceWindows ?? this.document.windows } : this.document?.restore ?? null, windows });
    this.resumedAttempt = false;
    this.signature = signature;
    return true;
  }
}
