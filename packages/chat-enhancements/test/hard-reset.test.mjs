import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HardResetFeed, scheduledHardReset, hardResetRange, powerShellHardResetFetch } from '../src/hard-reset.mjs';
import { weeklyProgress } from '../src/weekly-progress.mjs';

const day = 86400000;
const resetAt = Date.parse('2026-10-24T04:23:00Z');
const at = resetAt - 2 * day;
const forecast = { id: 'announcement', scheduledAt: at, announcedAt: at - day, sourceUrl: 'https://example.com/announcement' };

test('explicit recovery retries a halted feed, clears only after a real pass, and cannot restart a closed feed', async () => {
  let valid = false, calls = 0;
  const feed = new HardResetFeed({ fetchImpl: async () => { calls++; return Response.json(valid ? { data: { scheduled_reset: null } } : { data: {} }); } });
  await assert.rejects(feed.refresh()); assert.equal(feed.halted, true);
  const error = feed.error; assert.equal(await feed.refresh(), false); assert.equal(feed.error, error);
  await assert.rejects(feed.retry()); assert.equal(calls, 2);
  valid = true; assert.equal(await feed.retry(), true); assert.equal(feed.error, null);
  feed.close(); assert.equal(await feed.retry(), false); assert.equal(calls, 3);
});

test('explicit recovery retains an HTTP Retry-After boundary', async () => {
  let now = Date.now(), calls = 0;
  const feed = new HardResetFeed({ now: () => now, fetchImpl: async () => { calls++; return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : Response.json({ data: { scheduled_reset: null } }); } });
  await assert.rejects(feed.refresh());
  assert.equal(await feed.retry(), false); assert.equal(calls, 1);
  now = feed.error.retryAt; assert.equal(await feed.retry(), true); assert.equal(calls, 2); feed.close();
});
const scheduled = (overrides = {}) => ({ data: { scheduled_reset: { id: forecast.id, status: 'scheduled', reset_type: 'regular',
  scheduled_for: new Date(at).toISOString(), announced_at: new Date(at - day).toISOString(), source: { url: forecast.sourceUrl }, ...overrides } } });
const json = (body, etag = '"first"') => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', etag } });

test('only an explicit regular scheduled reset with an exact date updates the hard-reset forecast', () => {
  assert.deepEqual(scheduledHardReset(scheduled()), forecast);
  assert.equal(scheduledHardReset(scheduled({ reset_type: 'banked' })), null);
  assert.equal(scheduledHardReset(scheduled({ scheduled_for: null })), null);
  assert.equal(scheduledHardReset({ data: { scheduled_reset: null, active_watch: { expires_at: new Date(at).toISOString() } } }), null);
  assert.throws(() => scheduledHardReset({ data: {} }), /scheduled_reset field is missing/);
  assert.throws(() => scheduledHardReset(scheduled({ scheduled_for: 'tomorrow maybe' })), /invalid cached hard-reset forecast/);
});

test('a successful empty, banked or undated schedule clears a previously known hard-reset date', async () => {
  for (const body of [{ data: { scheduled_reset: null } }, scheduled({ reset_type: 'banked' }), scheduled({ scheduled_for: null })]) {
    const feed = new HardResetFeed({ fetchImpl: async () => json(body) });
    feed.forecast = forecast;
    await feed.refresh();
    assert.equal(feed.forecast, null);
    assert.equal(feed.error, null);
    feed.close();
  }
});

test('red range runs from its ETA to the right edge and is independent of the current-time foreground', () => {
  const weekly = { remainingPercent: 60, resetAt };
  const progress = weeklyProgress(weekly, resetAt - 3.5 * day);
  assert.equal(progress.days, 5);
  assert.deepEqual(hardResetRange(weekly, forecast, progress), { leftPercent: 60, widthPercent: 40 });
  const passed = { ...forecast, scheduledAt: resetAt - 4 * day };
  assert.deepEqual(hardResetRange(weekly, passed, progress), { leftPercent: 20, widthPercent: 80 });
  // The current-time layer at 30% masks the already elapsed red portion.
  assert.equal(Math.max(progress.timePercent, hardResetRange(weekly, passed, progress).leftPercent), 30);
});

test('shortening the visible scale preserves passed forecasts; a new full-week start retires old ones', () => {
  const weekly = { remainingPercent: 20, resetAt };
  const progress = weeklyProgress(weekly, resetAt - day);
  assert.equal(progress.days, 2);
  assert.deepEqual(hardResetRange(weekly, { ...forecast, scheduledAt: resetAt - 5 * day }, progress), { leftPercent: 0, widthPercent: 100 });
  const reset = { remainingPercent: 100, resetAt: resetAt + 6 * day };
  const full = weeklyProgress(reset, resetAt - day);
  assert.equal(full.days, 7);
  assert.equal(hardResetRange(reset, forecast, full), null);
  assert.deepEqual(hardResetRange(reset, { ...forecast, scheduledAt: full.startAt }, full), { leftPercent: 0, widthPercent: 100 });
  assert.equal(hardResetRange(weekly, { ...forecast, scheduledAt: resetAt }, progress), null);
  assert.equal(hardResetRange(weekly, null, progress), null);
});

test('one public request is shared, sends no account auth and uses conditional requests', async () => {
  let calls = 0, finish;
  const feed = new HardResetFeed({ fetchImpl(url, options) {
    calls++;
    assert.equal(url, 'https://codex-resets.com/api/v1/status');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    if (calls === 1) return new Promise(resolve => { finish = () => resolve(json(scheduled())); });
    assert.equal(options.headers['If-None-Match'], '"first"');
    return Promise.resolve(new Response(null, { status: 304 }));
  } });
  const first = feed.refresh();
  assert.equal(feed.refresh(), first);
  finish(); await first;
  assert.deepEqual(feed.snapshot().forecast, forecast);
  await feed.refresh();
  assert.equal(calls, 2);
  assert.deepEqual(feed.snapshot().forecast, forecast);
  feed.close();
});

test('public announcement checks are scheduled ten minutes apart', async () => {
  let now = at;
  const feed = new HardResetFeed({ now: () => now, fetchImpl: async () => json({ data: { scheduled_reset: null } }) });
  await feed.refresh();
  assert.equal(feed.nextCheckAt, now + 600000);
  now += 600000;
  await feed.refresh();
  assert.equal(feed.nextCheckAt, now + 600000);
  feed.close();
});

test('known transport failure retains the last date; malformed JSON stops automatic attempts with its original error', async () => {
  const transport = new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
  const unexpected = new SyntaxError('invalid JSON from upstream');
  let step = 0;
  const feed = new HardResetFeed({ fetchImpl: async () => {
    if (step++ === 0) return json(scheduled());
    if (step === 2) throw transport;
    return { ok: true, status: 200, json: async () => { throw unexpected; } };
  } });
  await feed.refresh();
  await assert.rejects(feed.refresh(), error => error === transport);
  assert.equal(feed.halted, false);
  assert.deepEqual(feed.forecast, forecast);
  await assert.rejects(feed.refresh(), error => error === unexpected);
  assert.equal(feed.halted, true);
  assert.equal(feed.error, unexpected);
  assert.deepEqual(feed.forecast, forecast);
  assert.equal(await feed.refresh(), false);
  feed.close();
});

test('HTTP 429 honors Retry-After; non-transient HTTP failures are not silently retried', async () => {
  const feed = new HardResetFeed({ fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }) });
  const before = Date.now();
  await assert.rejects(feed.refresh(), /HTTP 429/);
  assert.equal(feed.halted, false);
  assert.ok(feed.nextCheckAt >= before + 120000);
  feed.fetchImpl = async () => new Response(null, { status: 403 });
  await assert.rejects(feed.refresh(), /HTTP 403/);
  assert.equal(feed.halted, true);
  feed.close();
});

test('Windows HTTP transport preserves UTF-8, conditional headers and hidden-process execution', async () => {
  const abort = new AbortController();
  const fetcher = powerShellHardResetFetch(async (executable, args, options) => {
    assert.equal(executable, 'pwsh');
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-File', 'reader.ps1', '-ETag', 'W/"one"']);
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.windowsHide, true);
    assert.equal(options.signal, abort.signal);
    return { stdout: JSON.stringify({ status: 200, headers: { ETag: 'W/"two"' }, body: '{"文字":"预计重置"}' }) };
  }, 'pwsh', 'reader.ps1');
  const response = await fetcher('https://codex-resets.com/api/v1/status', { headers: { 'If-None-Match': 'W/"one"' }, signal: abort.signal });
  assert.deepEqual(await response.json(), { 文字: '预计重置' });
  assert.equal(response.headers.get('etag'), 'W/"two"');
});

test('Windows HTTP transport exposes known network errors but preserves unexpected process failures', async () => {
  const fetcher = powerShellHardResetFetch(async () => ({ stdout: JSON.stringify({ transportError: { name: 'System.Net.Http.HttpRequestException', message: 'network down', stack: 'original stack' } }) }), 'pwsh', 'reader.ps1');
  const options = { headers: {}, signal: new AbortController().signal };
  await assert.rejects(fetcher('', options), error => error.cause.name === 'System.Net.Http.HttpRequestException' && error.cause.stack === 'original stack');
  const original = new Error('PowerShell script error');
  const broken = powerShellHardResetFetch(async () => { throw original; }, 'pwsh', 'reader.ps1');
  await assert.rejects(broken('', options), error => error === original);
});

test('a successful empty schedule clears the persisted forecast and stays empty across restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-hard-reset-'));
  const cachePath = path.join(directory, 'forecast.json');
  const first = new HardResetFeed({ cachePath, fetchImpl: async () => json(scheduled()) });
  const second = new HardResetFeed({ cachePath, fetchImpl: async () => json({ data: { scheduled_reset: null } }) });
  const third = new HardResetFeed({ cachePath, fetchImpl: async () => json({ data: { scheduled_reset: null } }) });
  try {
    await first.refresh(); first.close();
    const bytes = await fs.readFile(cachePath);
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
    await second.refresh();
    assert.equal(second.forecast, null);
    assert.equal(JSON.parse(await fs.readFile(cachePath, 'utf8')), null);
    await third.refresh();
    assert.equal(third.forecast, null);
    assert.equal(third.error, null);
  } finally {
    first.close(); second.close(); third.close();
    await fs.unlink(cachePath);
    await fs.rmdir(directory);
  }
});
