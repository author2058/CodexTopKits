import fs from 'node:fs/promises';

export const HARD_RESET_SOURCE = 'https://codex-resets.com';
export const HARD_RESET_POLL_MS = 600000; // User-selected ten-minute public announcement check interval.

// Use the verified Windows HTTP path. Node's direct transport times out on this host.
export function powerShellHardResetFetch(execFile, executable, scriptPath) {
  return async (_url, options) => {
    const args = ['-NoProfile', '-NonInteractive', '-File', scriptPath];
    if (options.headers['If-None-Match']) args.push('-ETag', options.headers['If-None-Match']);
    const { stdout } = await execFile(executable, args, { encoding: 'utf8', windowsHide: true, signal: options.signal });
    const result = JSON.parse(stdout);
    if (result.transportError) {
      const cause = Object.assign(new Error(result.transportError.message), result.transportError, { code: 'PUBLIC_HTTP_TRANSPORT' });
      throw new TypeError('fetch failed', { cause });
    }
    return new Response(result.status === 304 ? null : result.body, { status: result.status, headers: result.headers });
  };
}

export function validateHardResetForecast(value) {
  if (value === null) return null;
  if (!value || typeof value.id !== 'string' || !Number.isFinite(value.scheduledAt)
      || !Number.isFinite(value.announcedAt) || typeof value.sourceUrl !== 'string') {
    throw new TypeError('Codex Resets: invalid cached hard-reset forecast.');
  }
  return { id: value.id, scheduledAt: value.scheduledAt, announcedAt: value.announcedAt, sourceUrl: value.sourceUrl };
}

export function scheduledHardReset(body) {
  if (!body?.data || !Object.hasOwn(body.data, 'scheduled_reset')) throw new TypeError('Codex Resets: scheduled_reset field is missing.');
  const scheduled = body.data.scheduled_reset;
  if (scheduled === null) return null;
  if (scheduled.status !== 'scheduled' || !['regular', 'banked'].includes(scheduled.reset_type)) {
    throw new TypeError('Codex Resets: scheduled reset status/type changed.');
  }
  // Banked credits and AI watches are not hard-reset dates. Null also means no exact ETA.
  if (scheduled.reset_type === 'banked' || scheduled.scheduled_for === null) return null;
  return validateHardResetForecast({ id: scheduled.id, scheduledAt: Date.parse(scheduled.scheduled_for),
    announcedAt: Date.parse(scheduled.announced_at), sourceUrl: scheduled.source?.url || HARD_RESET_SOURCE });
}

// Serialized into the renderer; keep it independent of module scope.
export function hardResetRange(weekly, forecast, progress) {
  const at = forecast?.scheduledAt;
  if (!progress || !Number.isFinite(at) || !Number.isFinite(weekly?.resetAt)
      || at < weekly.resetAt - 7 * 86400000 || at >= weekly.resetAt) return null;
  const leftPercent = Math.max(0, (at - progress.startAt) / (weekly.resetAt - progress.startAt) * 100);
  return { leftPercent, widthPercent: 100 - leftPercent };
}

class HardResetHttpError extends Error {
  constructor(response) {
    super(`Codex Resets status returned HTTP ${response.status}.`);
    this.name = 'HardResetHttpError';
    this.status = response.status;
    const after = response.headers.get('retry-after');
    this.retryAt = after === null ? 0 : /^\d+$/.test(after) ? Date.now() + Number(after) * 1000 : Date.parse(after);
  }
}

export function transientHardResetError(error) {
  if (error instanceof HardResetHttpError) return error.status === 429 || error.status >= 500;
  return error instanceof TypeError && error.message === 'fetch failed'
    && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'PUBLIC_HTTP_TRANSPORT'].includes(error.cause?.code);
}

export class HardResetFeed {
  constructor({ cachePath = null, fetchImpl = fetch, now = Date.now } = {}) {
    this.cachePath = cachePath;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.forecast = null;
    this.checkedAt = null;
    this.error = null;
    this.etag = null;
    this.loaded = false;
    this.pending = null;
    this.nextCheckAt = 0;
    this.halted = false;
    this.abort = new AbortController();
  }

  snapshot() {
    return { forecast: this.forecast, checkedAt: this.checkedAt,
      error: this.error ? { name: this.error.name, message: this.error.message } : null, source: HARD_RESET_SOURCE };
  }

  refresh() {
    if (this.pending) return this.pending;
    if (this.halted) return Promise.resolve(false);
    this.pending = this.read().finally(() => { this.pending = null; });
    return this.pending;
  }

  retry() {
    if (Number.isFinite(this.error?.retryAt) && this.now() < this.error.retryAt) return Promise.resolve(false);
    if (!this.abort.signal.aborted) this.halted = false;
    return this.refresh();
  }

  async read() {
    this.nextCheckAt = this.now() + HARD_RESET_POLL_MS;
    try {
      if (!this.loaded) {
        if (this.cachePath) {
          try { this.forecast = validateHardResetForecast(JSON.parse(await fs.readFile(this.cachePath, 'utf8'))); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        this.loaded = true;
      }
      const response = await this.fetchImpl(HARD_RESET_SOURCE + '/api/v1/status', {
        headers: { Accept: 'application/json', ...(this.etag ? { 'If-None-Match': this.etag } : {}) },
        redirect: 'error', signal: this.abort.signal,
      });
      if (response.status !== 304) {
        if (!response.ok) throw new HardResetHttpError(response);
        const forecast = scheduledHardReset(await response.json());
        if (JSON.stringify(forecast) !== JSON.stringify(this.forecast)) {
          if (this.cachePath) {
            const temporary = this.cachePath + '.tmp';
            await fs.writeFile(temporary, JSON.stringify(forecast) + '\n', { encoding: 'utf8', mode: 0o600 });
            await fs.rename(temporary, this.cachePath);
          }
          this.forecast = forecast;
        }
        this.etag = response.headers.get('etag');
      }
      this.checkedAt = this.now();
      this.error = null;
      return true;
    } catch (error) {
      this.error = error;
      this.halted = !transientHardResetError(error);
      if (Number.isFinite(error.retryAt)) this.nextCheckAt = Math.max(this.nextCheckAt, error.retryAt);
      throw error;
    }
  }

  close() { this.halted = true; this.abort.abort(); }
}
