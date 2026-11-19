import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../assets/context-recovery/scripts/recover-breakpoint.mjs', import.meta.url));
const thread = 'recovery-thread';
const at = (s) => new Date(Date.UTC(2026, 9, 4) + s * 1000).toISOString();
const event = (s, turn, type, extra = {}) => ({ timestamp: at(s), type: 'event_msg', payload: { type, turn_id: turn, ...extra } });
const message = (s, turn, id, role, text) => ({ timestamp: at(s), type: 'response_item', payload: { type: 'message', id, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], phase: role === 'assistant' ? 'commentary' : undefined, internal_chat_message_metadata_passthrough: { turn_id: turn } } });
const capacity = { message: 'Selected model is at capacity.', codex_error_info: 'server_overloaded' };
const compact = (s) => ({ timestamp: at(s), type: 'compacted', payload: { window_number: 273, window_id: 'window-new', previous_window_id: 'window-old', replacement_history: [] } });
const end = (s, turn = 'new') => [compact(s), event(s + 1, turn, 'item_completed', { item: { type: 'ContextCompaction' } })];
const old = (error = capacity) => [event(1, 'old', 'task_started'), message(2, 'old', 'original-auth', 'user', 'Continue the approved boundary'), message(3, 'old', 'old-checkpoint', 'assistant', 'Old breakpoint'), event(4, 'old', 'task_complete', error === null ? {} : { error, last_agent_message: null })];
const current = (s = 30000) => [event(s, 'new', 'task_started'), message(s + 1, 'new', 'environment', 'user', '<environment_context>date only</environment_context>'), message(s + 2, 'new', 'current-checkpoint', 'assistant', 'Current unfinished breakpoint'), ...end(s + 3)];

async function fixture(t, segments) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-recovery-test-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), 'codex-recovery-test-')));
    await fs.rm(root, { recursive: true, force: false });
  });
  const files = [];
  for (let i = 0; i < segments.length; i += 1) {
    const records = segments[i];
    const file = path.join(root, `rollout-${thread}-${i}.jsonl`);
    const meta = { timestamp: records[0]?.timestamp || at(0), type: 'session_meta', payload: { id: thread } };
    await fs.writeFile(file, [meta, ...records].map((r) => JSON.stringify(r)).join('\n') + '\n', { encoding: 'utf8' });
    files.push(file);
  }
  const run = async (extra = [], bound = 30005) => {
    const { stdout } = await exec(process.execPath, [script, '--thread-id', thread, '--hook-observed-at', at(bound), '--sessions-root', root, ...extra], { encoding: 'utf8' });
    return JSON.parse(stdout);
  };
  return { run, files, root };
}

test('same-turn recovery keeps current authorization and never needs prior-turn lookup', async (t) => {
  const f = await fixture(t, [[event(30000, 'new', 'task_started'), message(30001, 'new', 'current-auth', 'user', 'Current request'), message(30002, 'new', 'current-checkpoint', 'assistant', 'Current breakpoint'), ...end(30003)]]);
  const p = await f.run();
  assert.deepEqual(p.problems, []); assert.equal(p.latest.authorization.itemId, 'current-auth');
  assert.equal(p.authorizationSource, null); assert.equal(p.continuationLookup, null);
  assert.equal(p.safeToContinue, false);
});

test('overnight environment-only continuation inherits capacity-failed authorization but keeps current breakpoint', async (t) => {
  const f = await fixture(t, [[...old(), ...current()]]);
  const p = await f.run();
  assert.deepEqual(p.problems, []); assert.equal(p.currentTurnId, 'new');
  assert.equal(p.latest.authorization.itemId, 'original-auth'); assert.equal(p.latest.authorization.turnId, 'old');
  assert.equal(p.latest.agentCheckpoint.itemId, 'current-checkpoint'); assert.equal(p.latest.agentCheckpoint.turnId, 'new');
  assert.equal(p.authorizationSource.links[0].termination.status, 'failed');
  assert.deepEqual(p.authorizationSource.links[0].termination.error, capacity);
  assert.deepEqual(p.detailItemIds, ['original-auth', 'current-checkpoint']);
  assert.equal(p.safeToContinue, false); assert.equal(p.read.hardMaxBytes, 16777216);
  assert.ok(p.continuationLookup.every((v) => v.maxRetainedRecordBytes === 2097152));
});

test('normal completion, cancellation and unknown failures cannot supply old authorization', async (t) => {
  const cases = [old(null), [...old().slice(0, -1), event(4, 'old', 'task_interrupted')], old({ message: 'Unknown fault', codex_error_info: 'other' })];
  for (const records of cases) {
    const f = await fixture(t, [[...records, ...current()]]), p = await f.run();
    assert.ok(p.problems.includes('current-turn-authorization-unavailable'));
    assert.equal(p.latest.authorization, null); assert.equal(p.nextAction, 'remain-read-only');
    if (p.authorizationSource.precedingTurn.status === 'failed') assert.deepEqual(p.authorizationSource.precedingTurn.error, { message: 'Unknown fault', codex_error_info: 'other' });
  }
});

test('new current-turn user and agent instructions remain authoritative and bypass inheritance', async (t) => {
  for (const delegated of [false, true]) {
    const records = current();
    const input = delegated ? { timestamp: at(30001.5), type: 'response_item', payload: { type: 'function_call_output', id: 'agent-input', call_id: 'call', output: '<codex_delegation><source_thread_id>sender</source_thread_id><input>New instructions</input></codex_delegation>', internal_chat_message_metadata_passthrough: { turn_id: 'new' } } }
      : message(30001.5, 'new', 'new-auth', 'user', 'Stop the old task');
    records.splice(2, 0, input);
    const f = await fixture(t, [[...old(), ...records]]), p = await f.run();
    assert.equal(p.latest.authorization.itemId, delegated ? 'agent-input' : 'new-auth');
    assert.equal(p.authorizationSource, null);
  }
});

test('intervening real user or agent input is a barrier, not silently discarded', async (t) => {
  for (const delegated of [false, true]) {
    const input = delegated ? { timestamp: at(5), type: 'response_item', payload: { type: 'function_call_output', id: 'agent-input', call_id: 'call', output: '<codex_delegation><source_thread_id>sender</source_thread_id><input>New instructions</input></codex_delegation>', internal_chat_message_metadata_passthrough: { turn_id: 'old' } } }
      : message(5, 'old', 'stop', 'user', 'Stop');
    const f = await fixture(t, [[...old(), input, ...current()]]), p = await f.run();
    assert.equal(p.latest.authorization, null); assert.equal(p.authorizationSource.blockedReason, 'intervening-real-input');
  }
});

test('successive capacity failures carry the same original permission through explicit failure links', async (t) => {
  const records = [...old(), event(5, 'middle', 'task_started'), message(6, 'middle', 'middle-env', 'user', '<environment_context/>'), event(7, 'middle', 'task_complete', { error: capacity }), ...current()];
  const f = await fixture(t, [records]), p = await f.run();
  assert.deepEqual(p.problems, []); assert.equal(p.latest.authorization.itemId, 'original-auth');
  assert.deepEqual(p.authorizationSource.links.map((v) => [v.fromTurnId, v.toTurnId]), [['middle', 'new'], ['old', 'middle']]);
});

test('older verified segment supplies the exact authorization detail without changing the active segment', async (t) => {
  const f = await fixture(t, [old(), current()]), p = await f.run();
  assert.deepEqual(p.problems, []); assert.equal(p.rolloutPath, f.files[1]);
  assert.equal(p.authorizationSource.rolloutPath, f.files[0]);
  const detail = await f.run(['--item-id', p.latest.authorization.itemId, '--rollout', p.authorizationSource.rolloutPath]);
  assert.equal(detail.item.text, 'Continue the approved boundary'); assert.equal(detail.item.turnId, 'old');
});

test('intervening input in a newer segment remains visible when the failure boundary is in an older segment', async (t) => {
  const input = message(5, 'old', 'stop-in-new-segment', 'user', 'Stop');
  const f = await fixture(t, [old(), [input, ...current()]]), p = await f.run();
  assert.equal(p.latest.authorization, null);
  assert.equal(p.authorizationSource.blockedReason, 'intervening-real-input');
  assert.equal(p.authorizationSource.interveningInput.itemId, 'stop-in-new-segment');
  assert.equal(p.authorizationSource.interveningInput.rolloutPath, f.files[1]);
});

test('failed and cancelled current turns after compaction still trigger delayed-Hook protection', async (t) => {
  for (const ending of [event(30004.5, 'new', 'task_complete', { error: capacity }), event(30004.5, 'new', 'task_interrupted')]) {
    const f = await fixture(t, [[...old(), ...current(), ending]]), p = await f.run();
    assert.equal(p.hookTiming.delayed, true); assert.ok(p.problems.includes('compact-hook-delayed-beyond-target-turn'));
    assert.equal(p.continuationLookup, null); assert.equal(p.latest.authorization, null);
  }
});

test('replacement history cannot become authorization, and the exact-record capacity is not raised', async (t) => {
  const records = old().filter((r) => r.payload.id !== 'original-auth');
  const c = compact(8); c.payload.replacement_history = [message(2, 'old', 'fake-auth', 'user', 'Old invented authorization').payload];
  const f = await fixture(t, [[...records, c, ...current()]]), p = await f.run();
  assert.equal(p.latest.authorization, null); assert.ok(p.problems.includes('current-turn-authorization-unavailable'));
  const huge = old(); huge[1] = message(2, 'old', 'huge-auth', 'user', 'x'.repeat(2097153));
  const oversized = await fixture(t, [[...huge, ...current()]]);
  await assert.rejects(oversized.run(), /targeted-record limit/);
});

test('thread identity mismatch and missing predecessor evidence fail closed', async (t) => {
  const f = await fixture(t, [current()]), p = await f.run();
  assert.equal(p.latest.authorization, null); assert.ok(p.problems.includes('current-turn-authorization-unavailable'));
  const data = await fs.readFile(f.files[0], { encoding: 'utf8' });
  await fs.writeFile(f.files[0], data.replace('"id":"recovery-thread"', '"id":"different-thread"'), { encoding: 'utf8' });
  await assert.rejects(f.run(), /No verified rollout segment/);
});
