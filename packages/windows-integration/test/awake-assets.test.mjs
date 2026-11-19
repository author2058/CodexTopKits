import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../assets/codex-awake/', import.meta.url));
const writer = path.join(directory, 'Update-CodexAwakeState.ps1');

function write(stateDirectory, events, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', writer, '-EventName', 'NativeSync', '-StateDirectory', stateDirectory, '-NoLaunchWatcher'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let error = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { error += value; }); child.stdout.resume();
    child.once('error', reject); child.stdin.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(error)));
    child.stdin.end(JSON.stringify({ events, snapshot: null, ...options }), 'utf8');
  });
}

test('bundled Awake writer isolates installations and closes interrupted turns', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-awake-assets-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const first = path.join(root, 'first 中文'), second = path.join(root, 'second');
  await write(first, [{ method: 'turn/started', threadId: 'one', turnId: 'turn' }]);
  await write(second, [{ method: 'turn/started', threadId: 'two', turnId: 'other' }]);
  await write(first, [{ method: 'turn/completed', threadId: 'one', turnId: 'turn', outcome: 'interrupted' }]);
  const state = async dir => JSON.parse(await fs.readFile(path.join(dir, 'active.json'), 'utf8'));
  const a = await state(first), b = await state(second);
  assert.deepEqual(Object.keys(a.active), []); assert.equal(a.terminalTurns.turn.outcome, 'interrupted');
  assert.deepEqual(Object.keys(b.active), ['two:other']);
  const command = '$ErrorActionPreference = "Stop"; Import-Module -Name $env:CDTK_AWAKE_MODULE; @((Get-CodexAwakeObjectName $env:CDTK_AWAKE_FIRST State),(Get-CodexAwakeObjectName $env:CDTK_AWAKE_SECOND State),(Get-CodexAwakeObjectName $env:CDTK_AWAKE_FIRST Watcher),(Get-CodexAwakeObjectName $env:CDTK_AWAKE_SECOND Watcher),(Get-CodexAwakeObjectName $env:CDTK_AWAKE_FIRST Changed),(Get-CodexAwakeObjectName $env:CDTK_AWAKE_SECOND Changed)) | ConvertTo-Json -Compress';
  const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CDTK_AWAKE_MODULE: path.join(directory, 'CodexAwakeDiagnostics.psm1'), CDTK_AWAKE_FIRST: first, CDTK_AWAKE_SECOND: second } });
  const names = JSON.parse(stdout); assert.equal(new Set(names).size, 6);
});

test('bundled rollout reconciles a desktop turn in its private state directory', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-awake-rollout-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const sessions = path.join(root, 'sessions'), stateDirectory = path.join(root, 'state');
  await fs.mkdir(sessions);
  const rollout = path.join(sessions, 'rollout-test.jsonl');
  const append = value => fs.appendFile(rollout, JSON.stringify(value) + '\n', 'utf8');
  await append({ type: 'session_meta', payload: { id: 'one', originator: 'Codex Desktop' } });
  const command = '$ErrorActionPreference = "Stop"; Import-Module -Name $env:CDTK_AWAKE_MODULE; Sync-CodexAwakeRollout -StateDirectory $env:CDTK_AWAKE_STATE -RolloutRoot $env:CDTK_AWAKE_SESSIONS';
  const sync = () => promisify(execFile)('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CDTK_AWAKE_MODULE: path.join(directory, 'CodexAwakeRollout.psm1'), CDTK_AWAKE_STATE: stateDirectory, CDTK_AWAKE_SESSIONS: sessions } });
  await sync();
  await append({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }); await sync();
  let state = JSON.parse(await fs.readFile(path.join(stateDirectory, 'active.json'), 'utf8'));
  assert.ok(state.active['rollout:turn']);
  await append({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn', reason: 'interrupted' } }); await sync();
  state = JSON.parse(await fs.readFile(path.join(stateDirectory, 'active.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.active), []); assert.equal(state.terminalTurns.turn.outcome, 'aborted');
});

test('disable clears snapshot-only activity and blocks rollout until native sync re-enables', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-awake-disable-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const sessions = path.join(root, 'sessions'), stateDirectory = path.join(root, 'state'); await fs.mkdir(sessions);
  const rollout = path.join(sessions, 'rollout-test.jsonl');
  const append = value => fs.appendFile(rollout, JSON.stringify(value) + '\n', 'utf8');
  await append({ type: 'session_meta', payload: { id: 'one', originator: 'Codex Desktop' } });
  const command = '$ErrorActionPreference = "Stop"; Import-Module -Name $env:CDTK_AWAKE_MODULE; Sync-CodexAwakeRollout -StateDirectory $env:CDTK_AWAKE_STATE -RolloutRoot $env:CDTK_AWAKE_SESSIONS';
  const sync = () => promisify(execFile)('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CDTK_AWAKE_MODULE: path.join(directory, 'CodexAwakeRollout.psm1'), CDTK_AWAKE_STATE: stateDirectory, CDTK_AWAKE_SESSIONS: sessions } });
  const read = async () => JSON.parse(await fs.readFile(path.join(stateDirectory, 'active.json'), 'utf8'));
  await write(stateDirectory, [], { snapshot: { startedAt: Date.now(), loadedThreadIds: ['one'], busyThreadIds: ['one'] } });
  assert.ok((await read()).active['native-thread:one']);
  await sync();
  await append({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'rollout-turn' } }); await sync();
  assert.ok((await read()).active['rollout:rollout-turn']);
  await write(stateDirectory, [], { disable: true });
  let state = await read(); assert.equal(state.disabled, true); assert.deepEqual(Object.keys(state.active), []);
  await append({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } }); await sync();
  state = await read(); assert.equal(state.disabled, true); assert.deepEqual(Object.keys(state.active), []);
  await write(stateDirectory, [], { snapshot: { startedAt: Date.now(), loadedThreadIds: ['one'], busyThreadIds: ['one'] } });
  state = await read(); assert.equal(state.disabled, false); assert.ok(state.active['native-thread:one']);
});
