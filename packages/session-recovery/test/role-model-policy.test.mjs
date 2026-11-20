import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { selectEfforts } from '../src/model-effort-calculator.mjs';
import { defaultRolePolicy, validateRolePolicy, roleThreadKey } from '../src/role-model-policy.mjs';
import { openRoleModelBackend } from '../src/role-model-backend.mjs';
import { loadInputs } from '../src/model-effort-source.mjs';

function fixture() {
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const models = ['gpt-6-sol', 'gpt-6-terra', 'gpt-6-astra', 'gpt-6-luna'];
  const usage = { contract: 'deng-practical/1', ok: true, complete: true, source: 'codex', demo: false, from: '2026-11-20T08:00:00Z', to: '2026-11-20T10:00:00Z', asOf: '2026-11-20T10:00:00Z', models: models.map(model => ({ model, requests: 21, efforts: efforts.map((effort, i) => ({ effort, requests: i + 1 })) })) };
  const iq = { schema: 'codex-four-task-results/1', protocol: 'codex-four-weighted-150-v2', score_max: 150, round_id: 'fixture', score_snapshot_at: '2026-11-20T01:00:00Z', task_weights: { combined: 60, pompeii: 45, pelican: 22.5, candy: 22.5 }, model_efforts: Object.fromEntries(models.map(model => [model, efforts])), rows: models.flatMap(model => efforts.map((effort, i) => ({ model, effort, combined: { score: 40 + i * 10, model_elapsed_seconds: 10 }, pompeii: { score100: 100, model_elapsed_seconds: 10 }, pelican: { score: 0, model_elapsed_seconds: 10 }, candy: { correct: true, model_elapsed_seconds: 10 } }))) };
  return { usage, iq };
}

test('defaults contain exactly six roles, and allow edited IDs, names and families', () => {
  const policy = defaultRolePolicy();
  assert.deepEqual(policy.roles.map(({ id, name, family }) => [id, name, family]), [
    ['responder', 'Responder', 'sol'], ['implementer', 'Implementer', 'terra'], ['operator', 'Operator', 'luna'],
    ['reviewer', 'General reviewer', 'sol'], ['advanced-reviewer', 'Advanced reviewer', 'astra'], ['researcher', 'Researcher', 'astra'],
  ]);
  assert.deepEqual(policy.selection, { excludedEfforts: ['ultra'], excludeUnused: true, aboveMean: true, minIntelligenceGainPercent: 5, minSpeedPercent: 66, preferMajorityEffort: true });
  policy.roles[0] = { id: 'custom', name: 'Custom', family: 'luna' };
  assert.deepEqual(validateRolePolicy(policy), policy);
  policy.roles[0].family = 'other'; assert.throws(() => validateRolePolicy(policy), TypeError);
  assert.throws(() => roleThreadKey('', 'thread'), TypeError);
  assert.throws(() => roleThreadKey('host', 'x'.repeat(257)), TypeError);
  assert.notEqual(roleThreadKey('a', 'b,c'), roleThreadKey('a,b', 'c'));
});

test('custom selection excludes efforts from heat and mean and includes ultra in order', () => {
  const { usage, iq } = fixture();
  const row = structuredClone(usage.models[0]); row.model = 'gpt-5-sol'; row.efforts[5].requests = 100; row.requests = 115; usage.models.push(row);
  iq.model_efforts[row.model] = [...iq.model_efforts['gpt-6-sol']]; iq.rows.push(...iq.rows.filter(r => r.model === 'gpt-6-sol').map(r => ({ ...r, model: row.model })));
  assert.throws(() => selectEfforts(usage, iq), /Version heat is tied/);
  const custom = selectEfforts(usage, iq, { excludedEfforts: ['low'], excludeUnused: false, aboveMean: false, minIntelligenceGainPercent: 0, minSpeedPercent: 100 }).selections.sol;
  assert.equal(custom.selected.model, 'gpt-5-sol');
  assert.deepEqual(custom.levels.map(r => r.effort), ['medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(custom.meanScore, 109.5);
  assert.equal(custom.selected.effort, 'ultra');
});

test('custom thresholds retain strict intelligence and inclusive speed boundaries', () => {
  const { usage, iq } = fixture();
  for (const row of iq.rows) {
    const index = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].indexOf(row.effort);
    row.combined.score = [40, 40, 40, 50, 50, 50][index];
    for (const task of ['combined', 'pompeii', 'pelican', 'candy']) row[task].model_elapsed_seconds = index < 3 ? 5 : 10;
  }
  const lowScore = 40 * 0.6 + 67.5, highScore = 50 * 0.6 + 67.5;
  const options = { aboveMean: false, minIntelligenceGainPercent: 100 * (highScore / lowScore - 1), minSpeedPercent: 50 };
  assert.equal(selectEfforts(usage, iq, options).selections.sol.selected.effort, 'low');
  options.minIntelligenceGainPercent -= 0.001;
  assert.equal(selectEfforts(usage, iq, options).selections.sol.selected.effort, 'xhigh');
  options.minSpeedPercent += 0.001;
  assert.equal(selectEfforts(usage, iq, options).selections.sol.selected.effort, 'low');
});

test('serialized assignments persist per host; refresh coalesces and errors retain the last result', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-model-'));
  t.after(() => fs.rm(dir, { recursive: true }));
  const filename = path.join(dir, 'state.json'), inputs = fixture(), originalError = new Error('fixture failure');
  let calls = 0, fail = false;
  const errors = [];
  const backend = await openRoleModelBackend({ filename, loadInputs: async () => { calls++; if (fail) throw originalError; return inputs; }, onError: error => errors.push(error) });
  assert.deepEqual(backend.snapshot().assignments, {});
  const edited = backend.snapshot().policy; edited.roles[0].name = 'Edited';
  await Promise.all([backend.assign({ hostId: 'a', threadId: 'same', roleId: 'responder' }), backend.savePolicy(edited), backend.assign({ hostId: 'b', threadId: 'same', roleId: 'reviewer' })]);
  await Promise.all([backend.refresh(), backend.refresh()]);
  assert.equal(calls, 1);
  assert.equal(backend.snapshot().recommendationsValidated, true);
  const previous = backend.snapshot().recommendations;
  fail = true;
  await assert.rejects(backend.refresh(), error => error === originalError);
  assert.equal(backend.snapshot().error, originalError);
  assert.deepEqual(backend.snapshot().recommendations, previous);
  assert.deepEqual(errors, [originalError]);
  const policy = backend.snapshot().policy; policy.selection.aboveMean = false;
  await backend.savePolicy(policy);
  assert.equal(calls, 2);
  assert.equal(backend.snapshot().error, undefined);
  assert.equal(backend.snapshot().recommendationsValidated, true);
  assert.notDeepEqual(backend.snapshot().recommendations, previous);
  await backend.assign({ hostId: 'a', threadId: 'same', roleId: null });
  await backend.close();
  const reopened = await openRoleModelBackend({ filename });
  assert.deepEqual(reopened.snapshot().assignments, { [roleThreadKey('b', 'same')]: 'reviewer' });
  assert.deepEqual(reopened.snapshot().policy, policy);
  assert.deepEqual(reopened.snapshot().recommendations, backend.snapshot().recommendations);
  assert.equal(reopened.snapshot().recommendationsValidated, false);
  await reopened.close();
});

test('shared loading times out and backend close aborts pending network reads', async t => {
  const server = http.createServer(() => {}).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-cancel-'));
  t.after(() => fs.rm(dir, { recursive: true }));
  const url = 'http://127.0.0.1:' + server.address().port;
  await assert.rejects(loadInputs({ usage: url, iq: url, timeoutMs: 20 }), error => error.cause?.name === 'TimeoutError');
  const errors = [];
  const backend = await openRoleModelBackend({ filename: path.join(dir, 'state.json'), onError: error => errors.push(error), loadInputs: signal => loadInputs({ usage: url, iq: url, signal }) });
  const pending = backend.refresh();
  const rejection = assert.rejects(pending, error => error.cause?.name === 'AbortError');
  await backend.close();
  await rejection;
  assert.deepEqual(errors, []);
});

test('close preserves reported refresh errors and propagates an in-flight write error', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-close-'));
  t.after(() => fs.rm(dir, { recursive: true }));
  const original = new Error('load failed'), errors = [];
  const failed = await openRoleModelBackend({ filename: path.join(dir, 'state.json'), onError: error => errors.push(error), loadInputs: () => new Promise((resolve, reject) => setImmediate(() => reject(original))) });
  const pendingFailure = failed.refresh();
  const loadRejection = assert.rejects(pendingFailure, error => error === original);
  await failed.close(); await loadRejection;
  assert.deepEqual(errors, [original]);

  const writeErrors = [];
  const parent = path.join(dir, 'later-obstruction');
  const backend = await openRoleModelBackend({ filename: path.join(parent, 'state.json'), onError: error => writeErrors.push(error), loadInputs: async () => fixture() });
  await fs.writeFile(parent, 'x', 'utf8');
  const pendingWrite = backend.refresh();
  const writeRejection = assert.rejects(pendingWrite, error => error.code === 'EEXIST');
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(backend.close(), error => error.code === 'EEXIST');
  await writeRejection;
  assert.equal(writeErrors.length, 1);
});
