import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nativePowerState } from './auto-sleep.mjs';
const helperPath = fileURLToPath(new URL('./native-window.ps1', import.meta.url));

export class NativeWindowWorker {
  constructor(executable) {
    this.executable = executable;
    this.child = null;
    this.pending = new Map();
    this.stderr = '';
    this.closed = false;
    this.powerReady = false;
    this.powerError = null;
    this.powerListener = null;
    this.powerFailure = null;
    this.windowListener = null;
    this.windowFailure = null;
    this.exited = null;
  }

  async open() {
    this.child = spawn(this.executable, ['-NoProfile', '-File', helperPath, '-Server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.receive(line));
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4096); });
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code) => this.fail(new Error(`Native window worker exited (${code ?? 'unknown'}): ${this.stderr.trim() || 'no diagnostic output'}`)));
    // PowerShell's first post-resume startup can take longer than normal while
    // assemblies and the desktop session are restored.  This only affects the
    // one-time worker handshake; interactive focus calls retain their 3s limit.
    const encodingProbe = '编码验证✓🐮';
    const handshake = await this.request('ping', { probe: encodingProbe }, 10000);
    if (handshake?.probe !== encodingProbe || handshake?.inputEncoding !== 'utf-8' || handshake?.outputEncoding !== 'utf-8') {
      throw new Error('Native window worker UTF-8 handshake failed.');
    }
    return this;
  }

  receive(line) {
    let response;
    try { response = JSON.parse(line); } catch (error) { this.fail(error); return; }
    if (response?.event === 'window-placement') {
      if (Number.isSafeInteger(response.handle) && response.handle > 0) this.windowListener?.(response.handle);
      return;
    }
    if (response?.event === 'window-events-failed') {
      this.windowFailure?.(new Error(response.message || 'Native window position listener failed.'));
      return;
    }
    if (response?.event === 'power-state') {
      try {
        const snapshot = nativePowerState(response);
        void Promise.resolve(this.powerListener?.(snapshot)).catch(error => this.reportPowerFailure(error));
      } catch (error) { this.reportPowerFailure(error); }
      return;
    }
    if (typeof response?.id !== 'string') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout); this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result); else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'Native window worker rejected the request.'));
  }

  request(action, extra = {}, timeoutMs = 3000) {
    if (this.closed || !this.child?.stdin.writable) return Promise.reject(new Error('Native window worker is unavailable.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`Native window worker timed out while handling ${action}.`), { code: 'NATIVE_WORKER_TIMEOUT' })); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.child.stdin.write(`${JSON.stringify({ id, action, ...extra })}\n`, 'utf8'); } catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  async subscribePower(listener, onError) {
    this.powerListener = listener;
    this.powerFailure = onError;
    const snapshot = nativePowerState(await this.request('power-subscribe'));
    if (this.powerError) throw this.powerError;
    this.powerReady = true;
    await listener(snapshot);
    return snapshot;
  }

  async powerStatus() {
    if (!this.powerReady || this.closed) throw this.powerError || new Error('Native Windows power notification listener is unavailable.');
    const snapshot = nativePowerState(await this.request('power-status'));
    await this.powerListener(snapshot);
    return snapshot;
  }

  reportPowerFailure(error) {
    this.powerReady = false;
    this.powerError = error;
    void Promise.resolve(this.powerFailure?.(error)).catch(reportError => console.error('Native power failure reporting failed:', { error, reportError }));
  }

  async list() {
    const values = (await this.request('list'))?.handles;
    if (!Array.isArray(values) || !values.every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Native window list is invalid.');
    return values;
  }

  async foreground() {
    const handle = Number((await this.request('foreground'))?.handle);
    return Number.isSafeInteger(handle) && handle > 0 ? handle : null;
  }

  async find(threadTitle) {
    if (typeof threadTitle !== 'string' || !threadTitle.trim() || threadTitle.length > 240) throw new Error('Invalid Codex thread title.');
    const values = (await this.request('find', { title: threadTitle }, 10000))?.handles;
    if (!Array.isArray(values) || !values.every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Native window matches are invalid.');
    return values;
  }

  async focus(handle, processId) {
    if (!Number.isSafeInteger(handle) || handle <= 0 || !Number.isSafeInteger(processId) || processId <= 0) throw new Error('Invalid native Codex window identity.');
    return this.request('focus', { handle, processId });
  }

  async findTarget(targetId, processId) {
    if (typeof targetId !== 'string' || !targetId || !Number.isSafeInteger(processId) || processId <= 0) throw new TypeError('Invalid Codex target identity.');
    const values = (await this.request('find-target', { targetId, processId }, 10000))?.handles;
    if (!Array.isArray(values) || !values.every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Native target matches are invalid.');
    return values;
  }

  async watchWindows(handles, listener, onError) {
    this.windowListener = listener; this.windowFailure = onError;
    return this.request('window-watch', { handles });
  }

  placement(handle) { return this.request('placement', { handle }); }
  place(handle, placement) { return this.request('place', { handle, placement }); }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    if (this.powerListener) this.reportPowerFailure(error);
    this.windowFailure?.(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
  }

  async close() {
    this.closed = true;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('Native window worker was closed.')); }
    this.pending.clear();
    await this.exited;
  }
}
