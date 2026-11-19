import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import createAwakeService from '../src/awake-service.mjs';

const wait = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Expected Awake fixture state did not occur.'); };
async function artifacts(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-awake-kit-')); t.after(() => fs.rm(root, { recursive: true }));
  const source = await fs.readFile(new URL('../src/awake-bridge.mjs', import.meta.url), 'utf8');
  const build = async version => { const directory = path.join(root, version); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'backend.mjs'), source, 'utf8'); return { directory, manifest: { id: 'awake-bridge', version, backendEntry: 'backend.mjs', assets: ['codex-awake/Update-CodexAwakeState.ps1'] } }; };
  return [await build('0.1.0'), await build('0.2.0')];
}

test('Awake Kit preserves terminal events across an in-flight backend update', async t => {
  const [initial, next] = await artifacts(t), writes = [], health = []; let hold = false, release, started;
  const readStarted = new Promise(resolve => { started = resolve; });
  const snapshot = { loadedThreadIds: ['one'], busyThreadIds: ['one'] };
  const context = { evaluatePage: async () => hold ? new Promise(resolve => { release = resolve; started(); }) : snapshot, reportError: error => health.push(error), log: async () => {} };
  const service = await createAwakeService({ awakeScript: 'C:/Awake/Update.ps1' }, context, { writeAwakeBatch: async (_shell, _script, batch) => writes.push(batch) });
  try {
    await service.configure(['awake-bridge'], [initial]); assert.equal(writes.length, 0);
    service.receive('one', { kind: 'window-state', applicable: true }); await wait(() => writes.length === 1);
    hold = true; service.receive('one', { kind: 'window-activity', hostId: 'local', method: 'turn/started', params: { threadId: 'one', turnId: 'turn' } }); await readStarted;
    await import(pathToFileURL(path.join(next.directory, 'backend.mjs')).href);
    const upgrade = service.configure(['awake-bridge'], [next]); await new Promise(resolve => setImmediate(resolve));
    service.receive('one', { kind: 'window-activity', hostId: 'local', method: 'turn/completed', params: { threadId: 'one', turnId: 'turn', turnStatus: 'interrupted', privateOutput: 'do not record' } });
    hold = false; release(snapshot); await upgrade;
    await wait(() => writes.some(batch => batch.events.some(event => event.outcome === 'interrupted')));
    assert.equal(JSON.stringify(writes).includes('do not record'), false); assert.ok(health.every(error => !error));
  } finally { await service.close(); }
});

test('legacy Awake handoff reuses its window activity without a second listener owner', async t => {
  const [initial] = await artifacts(t), writes = []; let onActivity, onState, removed = 0;
  const owner = { awakeSettings: () => ({ handedOff: true, awakeScript: 'C:/Awake/Update.ps1', powershellPath: 'pwsh.exe' }), featureState: () => ({ windows: [{ applicable: true }] }),
    readAwakeActivity: async () => ({ loadedThreadIds: ['one'], busyThreadIds: [] }),
    onFeatureActivity(listener) { onActivity = listener; return () => removed++; }, onFeatureState(listener) { onState = listener; listener(); return () => removed++; } };
  const service = await createAwakeService({ legacyPlugin: 'windows' }, { getPlugin: () => owner, reportError() {}, log: async () => {} }, { writeAwakeBatch: async (_shell, _script, batch) => writes.push(batch) });
  try {
    await service.configure(['awake-bridge'], [initial]); await wait(() => writes.length === 1);
    onActivity('turn/completed', { threadId: 'one', turn: { id: 'done', status: 'failed' } }); await wait(() => writes.some(batch => batch.events.some(event => event.outcome === 'failed')));
    onState(); assert.equal(service.receive('one', { kind: 'window-activity', hostId: 'local', method: 'turn/started', params: {} }), false);
  } finally { await service.close(); }
  assert.equal(removed, 2);
  owner.awakeSettings = () => ({ handedOff: false }); await assert.rejects(createAwakeService({ legacyPlugin: 'windows' }, { getPlugin: () => owner }), /not handed off/);
});

test('bundled writer follows selected artifact and service state; explicit scripts keep their old arguments', async t => {
  const [initial, next] = await artifacts(t), writes = [];
  const stateDirectory = path.join(initial.directory, 'private-state');
  const context = { stateDirectory, evaluatePage: async () => ({ loadedThreadIds: [], busyThreadIds: [] }), reportError() {}, log: async () => {} };
  const service = await createAwakeService({}, context, { writeAwakeBatch: async (...args) => writes.push(args) });
  try {
    await assert.rejects(service.configure(['awake-bridge'], [{ ...initial, manifest: { ...initial.manifest, assets: [] } }]), /does not contain the bundled writer/);
    await service.configure(['awake-bridge'], [initial]);
    service.receive('one', { kind: 'window-state', applicable: true }); await wait(() => writes.length === 1);
    assert.equal(writes[0][1], path.join(initial.directory, 'codex-awake', 'Update-CodexAwakeState.ps1'));
    assert.equal(writes[0][3], stateDirectory);
    await service.configure(['awake-bridge'], [next]); await wait(() => writes.length === 2);
    assert.equal(writes[1][1], path.join(next.directory, 'codex-awake', 'Update-CodexAwakeState.ps1'));
    assert.equal(writes[1][3], stateDirectory);
  } finally { await service.close(); }
  const legacyWrites = [];
  const explicit = await createAwakeService({ awakeScript: 'C:/Awake/Update.ps1' }, context, { writeAwakeBatch: async (...args) => legacyWrites.push(args) });
  try {
    await explicit.configure(['awake-bridge'], [initial]);
    explicit.receive('one', { kind: 'window-state', applicable: true }); await wait(() => legacyWrites.length === 1);
    assert.equal(legacyWrites[0][1], 'C:/Awake/Update.ps1');
    assert.equal(legacyWrites[0][3], undefined);
  } finally { await explicit.close(); }
});

test('explicit disable drains bundled writes, ignores queued events, and ordinary close leaves state alone', async t => {
  const [initial] = await artifacts(t), writes = [];
  let resolveRead, started, hold = false;
  const reading = new Promise(resolve => { started = resolve; });
  const snapshot = { loadedThreadIds: ['one'], busyThreadIds: ['one'] };
  const context = { stateDirectory: path.join(initial.directory, 'state'), evaluatePage: async () => hold ? new Promise(resolve => { resolveRead = resolve; started(); }) : snapshot, reportError() {}, log: async () => {} };
  const service = await createAwakeService({}, context, { writeAwakeBatch: async (_shell, _script, batch) => writes.push(batch) });
  await service.configure(['awake-bridge'], [initial]);
  service.receive('one', { kind: 'window-state', applicable: true }); await wait(() => writes.length === 1);
  hold = true; service.receive('one', { kind: 'window-activity', hostId: 'local', method: 'turn/started', params: { threadId: 'one', turnId: 'first' } }); await reading;
  const stopping = service.configure([]);
  service.receive('one', { kind: 'window-activity', hostId: 'local', method: 'turn/started', params: { threadId: 'one', turnId: 'late' } });
  assert.equal(writes.length, 1);
  hold = false; resolveRead(snapshot); await stopping;
  assert.equal(writes.length, 3); assert.equal(writes[1].events[0].turnId, 'first'); assert.deepEqual(writes[2], { disable: true });
  await service.close(); assert.equal(writes.length, 3);
  const normalWrites = [];
  const normal = await createAwakeService({}, context, { writeAwakeBatch: async (_shell, _script, batch) => normalWrites.push(batch) });
  await normal.configure(['awake-bridge'], [initial]); normal.receive('one', { kind: 'window-state', applicable: true }); await wait(() => normalWrites.length === 1);
  await normal.close(); assert.equal(normalWrites.length, 1); assert.equal(normalWrites[0].disable, undefined);
});

test('disable failure preserves error and can be retried; external writer is not disabled', async t => {
  const [initial] = await artifacts(t), writes = [], failure = new Error('disable failed'); let fail = true;
  const context = { stateDirectory: path.join(initial.directory, 'state'), evaluatePage: async () => ({ loadedThreadIds: [], busyThreadIds: [] }), reportError() {}, log: async () => {} };
  const write = async (_shell, _script, batch) => { writes.push(batch); if (batch.disable && fail) { fail = false; throw failure; } };
  const service = await createAwakeService({}, context, { writeAwakeBatch: write });
  try {
    await service.configure(['awake-bridge'], [initial]);
    await assert.rejects(service.configure([]), error => error === failure);
    await service.configure([]); assert.equal(writes.filter(batch => batch.disable).length, 2);
  } finally { await service.close(); }
  const externalWrites = [];
  const external = await createAwakeService({ awakeScript: 'C:/Awake/Update.ps1' }, context, { writeAwakeBatch: async (_shell, _script, batch) => externalWrites.push(batch) });
  try {
    await external.configure(['awake-bridge'], [initial]);
    external.receive('one', { kind: 'window-state', applicable: true }); await wait(() => externalWrites.length === 1);
    await external.configure([]); assert.equal(externalWrites.length, 1);
  } finally { await external.close(); }
});

test('an in-flight error is preserved and disable can be retried after the bridge settles', async t => {
  const [initial] = await artifacts(t), writes = [], failure = new Error('activity failed'); let rejectRead, started;
  const reading = new Promise(resolve => { started = resolve; });
  const context = { stateDirectory: path.join(initial.directory, 'state'), evaluatePage: () => new Promise((_resolve, reject) => { rejectRead = reject; started(); }), reportError() {}, log: async () => {} };
  const service = await createAwakeService({}, context, { writeAwakeBatch: async (_shell, _script, batch) => writes.push(batch) });
  try {
    await service.configure(['awake-bridge'], [initial]);
    service.receive('one', { kind: 'window-state', applicable: true }); await reading;
    const stopping = service.configure([]); service.removeTarget('one'); rejectRead(failure);
    await assert.rejects(stopping, error => error === failure);
    await service.configure([]);
    assert.deepEqual(writes, [{ disable: true }]);
  } finally { await service.close(); }
});

test('old bundled backend is rejected while an explicit external writer remains compatible', async t => {
  const [initial] = await artifacts(t), backend = path.join(initial.directory, 'backend.mjs');
  const source = await fs.readFile(backend, 'utf8'); await fs.writeFile(backend, source.replace('export const supportsAwakeDisable = true;', ''), 'utf8');
  const context = { stateDirectory: path.join(initial.directory, 'state'), reportError() {}, log: async () => {} };
  const bundled = await createAwakeService({}, context);
  try { await assert.rejects(bundled.configure(['awake-bridge'], [initial]), /does not support safe disable/); } finally { await bundled.close(); }
  const external = await createAwakeService({ awakeScript: 'C:/Awake/Update.ps1' }, context);
  try { await external.configure(['awake-bridge'], [initial]); } finally { await external.close(); }
});
