import { spawn } from 'node:child_process';

export const supportsAwakeDisable = true;

// Only lifecycle metadata crosses this boundary, never prompt/output content.
export function awakeTurnEvent(method, params, observedAt = Date.now()) {
  if (!['turn/started', 'turn/completed'].includes(method)) return null;
  const threadId = params.threadId, turnId = params.turnId || params.turn?.id;
  if (!threadId || !turnId) throw new Error('Awake native turn event is missing identity.');
  const outcome = params.turnStatus || params.turn?.status;
  if (method === 'turn/completed' && !['completed', 'failed', 'interrupted'].includes(outcome)) throw new Error('Awake native terminal event has unknown status: ' + outcome);
  return { method, threadId, turnId, outcome, observedAt };
}

export function writeAwakeBatch(pwsh, script, batch, stateDirectory) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-File', script, '-EventName', 'NativeSync'];
    if (stateDirectory) args.push('-StateDirectory', stateDirectory);
    const child = spawn(pwsh, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { stderr += text; });
    child.stdout.resume();
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Awake state update exited ${code}: ${stderr.trim()}`)));
    child.stdin.end(JSON.stringify(batch), 'utf8');
  });
}

export class AwakeBridge {
  constructor({ readActivity, write, onHealth, now = Date.now }) {
    Object.assign(this, { readActivity, write, onHealth, now });
    this.events = new Map();
    this.pending = false;
    this.running = null;
    this.closed = false;
    this.error = null;
    this.lastAttempt = 0;
  }
  async observe(method, params) {
    let event;
    try { event = awakeTurnEvent(method, params, this.now()); }
    catch (error) { this.error = error; await this.onHealth(error, false); throw error; }
    if (event) this.events.set([event.method, event.threadId, event.turnId].join(':'), event);
    return this.refresh();
  }
  refresh() {
    if (this.closed) return Promise.resolve();
    this.pending = true;
    if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  async drain() {
    while (this.pending && !this.closed) {
      this.pending = false;
      const events = [...this.events.values()];
      this.events.clear();
      const startedAt = this.now();
      this.lastAttempt = startedAt;
      let snapshot = null, readError = null;
      try {
        const value = await this.readActivity();
        if (!Array.isArray(value?.loadedThreadIds) || !Array.isArray(value?.busyThreadIds)
            || ![...value.loadedThreadIds, ...value.busyThreadIds].every(id => typeof id === 'string' && id)
            || value.busyThreadIds.some(id => !value.loadedThreadIds.includes(id))) throw new Error('Invalid native Awake snapshot.');
        snapshot = { ...value, startedAt };
      } catch (error) { readError = error; }
      try {
        // Terminal events still commit if a simultaneous disconnect prevents a snapshot.
        if (snapshot || events.length) await this.write({ events, snapshot });
        if (readError) throw readError;
        const recovered = this.error !== null;
        this.error = null;
        await this.onHealth(null, recovered);
      } catch (error) {
        this.error = error;
        await this.onHealth(error, false);
        throw error;
      }
    }
  }
  close() { this.closed = true; return this.running; }
}
