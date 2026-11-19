// Retry only a component's recovery/check entry, never the failed user command.
export class RecoveryHealth {
  constructor(changed, diagnostic) {
    this.changed = changed;
    this.diagnostic = diagnostic;
    this.check = { ok: true, message: 'Ready.', issueCount: 0 };
    this.since = null;
    this.closed = false;
  }

  start(retry) { this.retry = retry; this.schedule(); }

  update(check) {
    if (this.closed) return;
    // Opening a connection is only progress until the recovery attempt finishes.
    if (check.ok && this.work) { this.pendingSuccess = check; return; }
    this.pendingSuccess = null;
    this.check = check;
    if (check.ok || check.recoverable === false) {
      this.since = null;
      clearTimeout(this.timer); this.timer = null;
      clearTimeout(this.deadline); this.deadline = null;
    } else if (this.since === null) {
      this.since = Date.now();
      this.deadline = setTimeout(() => { this.deadline = null; if (!this.closed) this.changed(); }, 60000);
      this.deadline.unref?.();
    }
    this.changed();
    this.schedule();
  }

  health() {
    return !this.check.ok && this.check.recoverable !== false && this.since !== null && Date.now() - this.since < 60000
      ? { ok: true, recovering: true, issueCount: 0, message: 'Reconnecting…', ...(this.check.issues ? { issues: this.check.issues } : {}) }
      : this.check;
  }

  schedule() {
    if (this.closed || this.check.ok || this.check.recoverable === false || !this.retry || this.timer || this.work) return;
    this.timer = setTimeout(() => { this.timer = null; void this.run().catch(() => { /* The attempt retains its failure in health and diagnostics. */ }); }, 5000);
    this.timer.unref?.();
  }

  run(retry = this.retry, force = false) {
    if (this.closed || !retry || !force && (this.check.ok || this.check.recoverable === false)) return Promise.resolve();
    if (this.work) return this.work;
    this.work = Promise.resolve().then(retry).catch(error => {
      if (this.closed) return;
      this.diagnostic(error);
      const issues = this.check.issues && (this.check.issues.some(issue => issue.message === error.message) ? this.check.issues
        : [...this.check.issues.filter(issue => issue.key !== '@recovery'), { key: '@recovery', message: error.message }]);
      try { this.update({ ok: false, issueCount: issues ? issues.length : this.check.issueCount || 1, message: error.message,
        ...(issues ? { issues } : {}), ...(this.check.recoverable === false ? { recoverable: false } : {}) }); }
      catch (listenerError) { throw new AggregateError([error, listenerError], 'Plugin check and host notification failed.', { cause: error }); }
      throw error;
    }).finally(() => {
      this.work = null;
      if (this.pendingSuccess) this.update(this.pendingSuccess);
      else this.schedule();
    });
    return this.work;
  }

  close() {
    this.closed = true;
    this.pendingSuccess = null;
    clearTimeout(this.timer); clearTimeout(this.deadline);
    return this.work;
  }
}
