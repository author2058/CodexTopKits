import { fork } from 'node:child_process';

export class FeatureLoader {
  constructor({ onExit = () => {} } = {}) {
    this.pending = new Map(); this.nextId = 0; this.closing = false;
    this.child = fork(new URL('./feature-loader-worker.mjs', import.meta.url), [], { windowsHide: true, execArgv: [], serialization: 'json', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    this.child.stderr.setEncoding('utf8'); this.diagnostics = '';
    this.child.stderr.on('data', value => { this.diagnostics += value; });
    const failed = error => { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); if (!this.closing) onExit(error); };
    this.child.on('error', failed);
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => {
      failed(Object.assign(new Error('Feature host exited (' + (code ?? signal) + '): ' + this.diagnostics.trim()), { code: 'FEATURE_HOST_EXITED' })); resolve();
    }));
    this.child.on('message', value => {
      const request = this.pending.get(value.id); if (!request) return; this.pending.delete(value.id);
      value.error ? request.reject(Object.assign(new Error(value.error.message), value.error)) : request.resolve(value.result);
    });
  }
  request(action, value) {
    if (!this.child.connected) return Promise.reject(new Error('The feature host is disconnected.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.child.send({ id, action, value }, error => {
      if (error) { this.pending.delete(id); reject(error); }
    }); });
  }
  async close() { this.closing = true; if (this.child.connected) this.child.disconnect(); await this.exited; }
}
