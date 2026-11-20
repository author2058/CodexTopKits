import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectEfforts as selectWithPolicy, readJson, main } from './select-model-effort.mjs';

const selectEfforts = (usage, iq) => selectWithPolicy(usage, iq, { preferMajorityEffort: false });

const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
function fixture({ scores = [67.5, 75, 90, 99, 105], times = [40, 50, 100, 110, 140], requests = [1, 2, 10, 20, 30] } = {}) {
  const models = ['gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6.2-astra', 'gpt-6-luna'];
  const usage = { contract: 'deng-practical/1', ok: true, complete: true, source: 'codex', demo: false, from: '2026-11-20T08:00:00Z', to: '2026-11-20T10:00:00Z', asOf: '2026-11-20T10:41:58Z', models: models.map(model => ({ model, requests: requests.reduce((a, b) => a + b, 0), efforts: efforts.map((effort, i) => ({ effort, requests: requests[i] })) })) };
  const iq = { schema: 'codex-four-task-results/1', protocol: 'codex-four-weighted-150-v2', score_max: 150, round_id: 'fixture', score_snapshot_at: '2026-11-20T01:09:52Z', task_weights: { combined: 60, pompeii: 45, pelican: 22.5, candy: 22.5 }, model_efforts: Object.fromEntries(models.map(model => [model, [...efforts]])), rows: models.flatMap(model => efforts.map((effort, i) => ({ model, effort, combined: { score: (scores[i] - 67.5) / 0.6, model_elapsed_seconds: times[i] / 4 }, pompeii: { score100: 100, model_elapsed_seconds: times[i] / 4 }, pelican: { score: 0, model_elapsed_seconds: times[i] / 4 }, candy: { correct: true, model_elapsed_seconds: times[i] / 4 } }))) };
  return { usage, iq };
}

function setSolRequests(usage, counts, extras = []) {
  const row = usage.models[0];
  row.efforts = efforts.map((effort, i) => ({ effort, requests: counts[i] })).concat(extras);
  row.requests = row.efforts.reduce((sum, item) => sum + item.requests, 0);
}

test('default majority selects even a slow below-mean effort without comparisons', () => {
  const { usage, iq } = fixture({ times: [1000, 50, 100, 110, 140] });
  setSolRequests(usage, [40, 2, 1, 1, 1]);
  const sol = selectWithPolicy(usage, iq).selections.sol;
  assert.equal(sol.selected.effort, 'low');
  assert.ok(sol.selected.score < sol.meanScore);
  assert.deepEqual(sol.majority, { effort: 'low', requests: 40, totalRequests: 45, share: 40 / 45 });
  assert.equal(sol.decision, 'version_majority');
  assert.deepEqual(sol.comparisons, []);
  assert.notEqual(selectWithPolicy(usage, iq, { preferMajorityEffort: false }).selections.sol.selected.effort, 'low');
});

test('majority uses only the chosen version, never other versions', () => {
  const { usage, iq } = fixture();
  const older = structuredClone(usage.models[0]); older.model = 'gpt-6.1-sol';
  older.efforts.forEach((row, index) => { row.requests = index === 0 ? 60 : 0; }); older.requests = 60;
  usage.models.push(older);
  const sol = selectWithPolicy(usage, iq).selections.sol;
  assert.equal(sol.selected.model, 'gpt-6.2-sol');
  assert.equal(sol.decision, 'score_speed_comparison');
  assert.equal(sol.majority, null);
  assert.equal(sol.selected.effort, 'max');
});

test('the complete chosen-version total includes unknown and ultra and exactly half is not a majority', () => {
  for (const effort of ['unknown', 'ultra']) {
    const { usage, iq } = fixture();
    setSolRequests(usage, [1, 2, 60, 10, 10], [{ effort, requests: 40 }]);
    assert.equal(selectWithPolicy(usage, iq).selections.sol.majority, null);
  }
  const { usage, iq } = fixture();
  setSolRequests(usage, [1, 2, 50, 20, 27]);
  assert.equal(selectWithPolicy(usage, iq).selections.sol.majority, null);
});

test('ultra never triggers the majority shortcut and explicit exclusions are respected', () => {
  const { usage, iq } = fixture();
  setSolRequests(usage, [1, 2, 10, 20, 30], [{ effort: 'ultra', requests: 1000 }]);
  iq.model_efforts['gpt-6.2-sol'].push('ultra');
  iq.rows.push({ ...structuredClone(iq.rows.find(r => r.model === 'gpt-6.2-sol' && r.effort === 'max')), effort: 'ultra' });
  assert.equal(selectWithPolicy(usage, iq, { excludedEfforts: [] }).selections.sol.majority, null);
  setSolRequests(usage, [40, 2, 1, 1, 1]);
  assert.equal(selectWithPolicy(usage, iq, { excludedEfforts: ['low', 'ultra'] }).selections.sol.majority, null);
});

test('a majority unavailable on the chosen model or missing its scoring row is an error', () => {
  for (const unsupported of [true, false]) {
    const { usage, iq } = fixture(); setSolRequests(usage, [40, 2, 1, 1, 1]);
    iq.rows = iq.rows.filter(row => !(row.model === 'gpt-6.2-sol' && row.effort === 'low'));
    if (unsupported) iq.model_efforts['gpt-6.2-sol'] = iq.model_efforts['gpt-6.2-sol'].filter(e => e !== 'low');
    assert.throws(() => selectWithPolicy(usage, iq), unsupported ? /Majority effort is not supported/ : /Incomplete or duplicate intelligence rows/);
  }
});

test('all four families are computed without mutating the snapshots', () => {
  const f = fixture(), original = structuredClone(f), result = selectEfforts(f.usage, f.iq);
  assert.deepEqual(f, original);
  assert.deepEqual(Object.values(result.selections).map(r => r.selected.effort), ['max', 'max', 'max', 'max']);
});

test('version heat excludes ultra and unknown, and chooses the more used version', () => {
  const { usage, iq } = fixture();
  const older = structuredClone(usage.models[0]); older.model = 'gpt-6.1-sol';
  usage.models[0].requests += 10000; usage.models[0].efforts.push({ effort: 'ultra', requests: 10000 });
  older.requests++; older.efforts[0].requests++; usage.models.push(older);
  iq.model_efforts[older.model] = [...efforts]; iq.rows.push(...iq.rows.filter(r => r.model === 'gpt-6.2-sol').map(r => ({ ...r, model: older.model })));
  assert.equal(selectEfforts(usage, iq).selections.sol.selected.model, 'gpt-6.1-sol');
});

test('unused efforts are excluded, while their scores remain in the model mean', () => {
  const { usage, iq } = fixture({ requests: [1, 2, 0, 20, 30] });
  const r = selectEfforts(usage, iq).selections.luna;
  assert.equal(r.meanScore, 87.3);
  assert.equal(r.levels.find(r => r.effort === 'high').excluded, 'unused');
  assert.notEqual(r.selected.effort, 'high');
});

test('ultra never contributes to the intelligence mean or candidate validation', () => {
  const { usage, iq } = fixture();
  const before = selectEfforts(usage, iq);
  iq.model_efforts['gpt-6.2-sol'].push('ultra'); iq.rows.push({ model: 'gpt-6.2-sol', effort: 'ultra' });
  assert.deepEqual(selectEfforts(usage, iq), before);
});

test('a more-used lower effort wins regardless of the higher score', () => {
  const { usage, iq } = fixture({ requests: [1, 2, 100, 20, 30] });
  assert.equal(selectEfforts(usage, iq).selections.sol.selected.effort, 'high');
});

test('exactly 5 percent intelligence gain does not upgrade', () => {
  const { usage, iq } = fixture({ scores: [67.5, 67.5, 90, 94.5, 94.5] });
  assert.equal(selectEfforts(usage, iq).selections.sol.selected.effort, 'high');
});

test('exactly 66 percent speed is accepted, below it is rejected', () => {
  for (const [time, expected] of [[100, 'xhigh'], [100.01, 'high']]) {
    const { usage, iq } = fixture({ scores: [67.5, 67.5, 90, 99, 99], times: [40, 50, 66, time, 200], requests: [1, 2, 10, 20, 1] });
    assert.equal(selectEfforts(usage, iq).selections.sol.selected.effort, expected);
  }
});

test('effort count ties retain the lower effort', () => {
  const { usage, iq } = fixture({ requests: [1, 2, 10, 10, 10] });
  assert.equal(selectEfforts(usage, iq).selections.sol.selected.effort, 'high');
});

test('the arithmetic mean threshold is strict', () => {
  const { usage, iq } = fixture({ scores: [90, 90, 90, 90, 90] });
  assert.throws(() => selectEfforts(usage, iq), /No used effort strictly above/);
});

test('unscored popular versions and version ties do not silently choose another version', () => {
  for (const [delta, message] of [[1, /intelligence efforts/], [0, /Version heat is tied/]]) {
    const { usage, iq } = fixture(), row = structuredClone(usage.models[0]); row.model = 'gpt-6.3-sol'; row.requests += delta; row.efforts[0].requests += delta; usage.models.push(row);
    assert.throws(() => selectEfforts(usage, iq), message);
  }
});

test('malformed counts, missing scores and invalid durations are visible errors', () => {
  const mutations = [
    f => { f.usage.models[0].requests++; },
    f => { f.usage.models[0].efforts[0].requests = -1; },
    f => { f.iq.rows[0].pompeii.score100 = null; },
    f => { f.iq.rows[0].combined.model_elapsed_seconds = 0; },
    f => { f.iq.rows.pop(); },
    f => { f.iq.rows.push(f.iq.rows[0]); },
    f => { f.iq.task_weights.pompeii = 40; },
    f => { f.usage.complete = false; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => selectEfforts(f.usage, f.iq), TypeError); }
});

test('no used models is an error, even when only ultra has requests', () => {
  const { usage, iq } = fixture({ requests: [0, 0, 0, 0, 0] }); usage.models[0].efforts.push({ effort: 'ultra', requests: 100 }); usage.models[0].requests = 100;
  assert.throws(() => selectEfforts(usage, iq), /No used model/);
});

test('UTF-8 files, one BOM and offline CLI input work; malformed input remains an error', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'effort-selector-'));
  t.after(() => fs.rm(dir, { recursive: true }));
  const { usage, iq } = fixture(), u = path.join(dir, 'usage.json'), i = path.join(dir, 'iq.json');
  await fs.writeFile(u, '\uFEFF' + JSON.stringify(usage), 'utf8'); await fs.writeFile(i, JSON.stringify(iq), 'utf8');
  assert.deepEqual(await readJson(u), usage);
  assert.equal(JSON.parse(await main(['--usage', u, '--iq', i])).selections.sol.selected.effort, 'max');
  await fs.writeFile(u, '{broken', 'utf8'); await assert.rejects(readJson(u), SyntaxError);
  await fs.writeFile(u, Buffer.from([0xff])); await assert.rejects(readJson(u), TypeError);
  await assert.rejects(readJson(path.join(dir, 'missing')), { code: 'ENOENT' });
});

test('HTTP status, JSON errors and cancellation retain their original causes', async t => {
  const server = http.createServer((request, response) => {
    if (request.url === '/wait') return;
    response.writeHead(request.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
    response.end(request.url === '/bad' ? '{broken' : '{"ok":true}');
  }).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.deepEqual(await readJson(url), { ok: true });
  await assert.rejects(readJson(url + '/missing'), { statusCode: 404 });
  await assert.rejects(readJson(url + '/bad'), SyntaxError);
  await assert.rejects(main(['--usage', url + '/missing', '--iq', url + '/wait']), { statusCode: 404 });
  const controller = new AbortController(), reason = new Error('stop this read'), pending = readJson(url + '/wait', controller.signal); controller.abort(reason);
  await assert.rejects(pending, e => e.cause === reason);
});

test('help and invalid options do not perform network requests', async () => {
  assert.match(await main(['--help']), /No Codex settings are changed/);
  await assert.rejects(main(['--timeout-ms', '0']), /positive integer/);
  await assert.rejects(main(['--unknown']), /Unknown option/);
});
