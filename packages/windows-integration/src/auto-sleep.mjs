// These are the two transient read failures observed in the native bridge logs.
// Other errors (including schema/identity failures) must still stop and report.
const isActivityReadDelay = error => [
  'mcp-response timed out.',
  'App server request expired while queued',
  'Renderer evaluation failed: Error: mcp-response timed out.',
  'Renderer evaluation failed: Error: App server request expired while queued',
].includes(error.message?.split('\n')[0]);

export class AutoSleepMonitor {
  constructor({ readActivity, publish, sleep, onError, checkPower = async () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { readActivity, publish, sleep, onError, checkPower, now, setTimer, clearTimer });
    this.enabled = false;
    this.ready = false;
    this.busyThreadIds = [];
    this.deadline = null;
    this.timer = null;
    this.revision = 0;
    this.toggleRevision = 0;
    this.activity = new Map();
    this.lastActivityWasStart = false;
    this.inFlight = null;
    this.error = null;
    this.powerSequence = 0;
  }
  status() { return { enabled: this.enabled, ready: this.ready, busyThreadIds: this.busyThreadIds, deadline: this.deadline, error: this.error, revision: this.revision }; }
  cancel() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; this.deadline = null; }
  waitForQuiet() {
    this.cancel();
    this.ready = false;
    this.deadline = this.now() + 60000;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.commit().catch(error => this.fail(error)).catch(error => console.error('Auto-sleep error publication failed:', error));
    }, 60000);
  }
  async setEnabled(enabled) {
    this.toggleRevision = ++this.revision;
    const revision = this.revision;
    this.enabled = enabled;
    this.ready = false;
    this.error = null;
    this.cancel();
    if (enabled) {
      try { await this.checkPower(); }
      catch (error) { if (revision === this.revision) this.enabled = false; throw error; }
      if (!this.enabled || revision !== this.revision) return false;
      this.waitForQuiet();
    }
    await this.publish(this.status());
  }
  async powerChanged(snapshot) {
    const power = nativePowerState(snapshot);
    if (power.sequence <= this.powerSequence) return false;
    this.powerSequence = power.sequence;
    // Treat a real OS power boundary like an explicit off, not an activity
    // change: an older in-flight check must never restore this authorization.
    this.toggleRevision = ++this.revision;
    this.enabled = false;
    this.ready = false;
    this.error = null;
    this.cancel();
    // UI connections can disappear as the OS suspends. The controller records
    // such delivery failures and resynchronizes on reconnect; revocation is final.
    await this.publish(this.status(), { powerBoundary: true });
    return true;
  }
  async observe(method, params) {
    const status = params.status?.type || params.thread?.status?.type;
    const statusEvent = method === 'thread/status/changed' || method === 'thread/started';
    const start = method === 'turn/started' || statusEvent && status === 'active';
    const stop = method === 'turn/completed' || method === 'thread/closed'
      || statusEvent && ['idle', 'notLoaded', 'systemError'].includes(status);
    if (!start && !stop) return;
    const threadId = params.threadId || params.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Auto-sleep activity event is missing a thread ID.');
    const turnId = params.turnId || params.turn?.id || null;
    const previous = this.activity.get(threadId);
    if (method === 'turn/completed' && turnId && previous?.active && previous.turnId && turnId !== previous.turnId) return;
    if (method === 'turn/started' && turnId && previous?.turnId === turnId && !previous.active) return;
    if (previous?.active === start && (!turnId || previous.turnId === turnId)) return;
    this.activity.set(threadId, { active: start, turnId: turnId || previous?.turnId || null });
    this.lastActivityWasStart = start;
    this.busyThreadIds = [...this.activity].filter(([, value]) => value.active).map(([id]) => id);
    this.revision++;
    if (!this.enabled) return;
    this.ready = false;
    this.error = null;
    this.cancel();
    // Lifecycle events update only local state. No backend read until a full
    // minute after the last genuine stop, regardless of window duplicates.
    if (stop) this.waitForQuiet();
    await this.publish(this.status());
  }
  async commit() {
    if (this.inFlight) return this.inFlight;
    if (!this.enabled || this.deadline === null || this.now() < this.deadline) return false;
    this.inFlight = this.checkAfterQuiet();
    try { return await this.inFlight; }
    finally { this.inFlight = null; }
  }
  async checkAfterQuiet() {
    const revision = this.revision;
    await this.checkPower();
    if (!this.enabled || revision !== this.revision) return false;
    let activity;
    try { activity = await this.readActivity(); }
    catch (error) {
      if (!this.enabled || revision !== this.revision) { await this.onError(error); return false; }
      if (!isActivityReadDelay(error)) throw error;
      // Keep the user's monitoring intent. A named transient failure begins
      // another full quiet minute, with an observable error and no fast retry.
      this.error = error.message;
      this.waitForQuiet();
      await this.onError(error);
      await this.publish(this.status());
      return false;
    }
    if (!this.enabled || revision !== this.revision) return false;
    if (!Array.isArray(activity?.busyThreadIds) || !activity.busyThreadIds.every(id => typeof id === 'string' && id)) throw new Error('Auto-sleep activity snapshot is invalid.');
    this.ready = true;
    this.error = null;
    this.busyThreadIds = [...new Set(activity.busyThreadIds)];
    const busy = new Set(this.busyThreadIds);
    for (const [id, value] of this.activity) this.activity.set(id, { active: busy.has(id), turnId: busy.has(id) && !value.active ? null : value.turnId });
    for (const id of busy) if (!this.activity.has(id)) this.activity.set(id, { active: true, turnId: null });
    this.cancel();
    if (busy.size) { await this.publish(this.status()); return false; }
    this.enabled = false;
    // Wait for all live window buttons to turn off before issuing the OS request.
    await this.publish(this.status());
    // Query the already-running native worker, not a timer or renderer cache.
    // This also catches a power callback queued while the backend read ran.
    await this.checkPower();
    if (revision !== this.revision) {
      // A new turn/stop during publication cancels this sleep, not the user's
      // intent. An explicit toggle or controller close remains authoritative.
      if (this.toggleRevision <= revision) {
        this.enabled = true;
        if (!this.lastActivityWasStart) this.waitForQuiet();
        await this.publish(this.status());
      }
      return false;
    }
    await this.sleep();
    return true;
  }
  async fail(error) {
    this.revision++;
    this.enabled = false;
    this.ready = false;
    this.error = error.message;
    this.cancel();
    await this.onError(error);
    await this.publish(this.status());
  }
  close() { this.enabled = false; this.toggleRevision = ++this.revision; this.cancel(); }
}

export function nativePowerState(value) {
  if (value?.ready !== true || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || !Number.isFinite(value.observedAt) || value.observedAt < 0
    || (value.sequence === 0 ? value.type !== null : !['suspend', 'resume'].includes(value.type))) {
    throw new TypeError('Native Windows power notification state is invalid or unavailable.');
  }
  return { ready: true, sequence: value.sequence, type: value.type, observedAt: value.observedAt };
}

// Serialized into each renderer; query the backend, not the sidebar/cache.
export async function readSleepActivity(request, source = 'auto_sleep', progress = () => {}) {
  const stage = async (method, read) => {
    const started = performance.now();
    progress({ method, status: 'started', elapsedMs: 0 });
    let succeeded = false;
    try { const value = await read(); succeeded = true; return value; }
    finally { progress({ method, status: succeeded ? 'succeeded' : 'failed', elapsedMs: Math.round(performance.now() - started) }); }
  };
  const ids = new Set();
  let cursor = null;
  await stage('thread/loaded/list', async () => {
    do {
      const page = await request('thread/loaded/list', { cursor }, source + '_loaded_threads');
      if (!Array.isArray(page?.data) || !page.data.every(id => typeof id === 'string')) throw new Error('thread/loaded/list returned an invalid auto-sleep snapshot.');
      for (const id of page.data) ids.add(id);
      cursor = page.nextCursor;
    } while (cursor);
  });
  const threads = await stage('thread/read', () => Promise.all([...ids].map(async threadId => {
    const result = await request('thread/read', { threadId, includeTurns: false }, source + '_thread_status');
    const thread = result?.thread;
    if (thread?.id !== threadId || !['active', 'idle', 'notLoaded', 'systemError'].includes(thread.status?.type)) throw new Error('thread/read returned an invalid auto-sleep status for ' + threadId);
    return thread;
  })));
  return { threadCount: threads.length, loadedThreadIds: threads.map(thread => thread.id), busyThreadIds: threads.filter(thread => thread.status.type === 'active').map(thread => thread.id) };
}
