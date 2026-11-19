import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditHook, auditRollout, inspectImage } from '../src/image-delivery-audit.mjs';

function webp(lossless) {
  const body = Buffer.alloc(lossless ? 5 : 10);
  if (lossless) { body[0] = 0x2f; body.writeUInt32LE(95 | (63 << 14), 1); }
  else { body.writeUInt16LE(96, 6); body.writeUInt16LE(64, 8); }
  const chunk = Buffer.alloc(8); chunk.write(lossless ? 'VP8L' : 'VP8 '); chunk.writeUInt32LE(body.length, 4);
  const riff = Buffer.alloc(12); riff.write('RIFF'); riff.writeUInt32LE(4 + chunk.length + body.length + (body.length & 1), 4); riff.write('WEBP', 8);
  return Buffer.concat([riff, chunk, body, Buffer.alloc(body.length & 1)]);
}

test('distinguishes lossy/lossless WebP by bitstream, not extension', () => {
  for (const lossless of [false, true]) {
    const result = inspectImage(webp(lossless));
    assert.equal(result.compression, lossless ? 'lossless' : 'lossy');
    assert.equal(result.width, 96); assert.equal(result.height, 64);
  }
  assert.throws(() => inspectImage(webp(false).subarray(0, 25)), /Truncated/);
});

test('hook logs metadata, preserves PNG intent, rejects disguised bytes without rewriting', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-delivery-hook-'));
  const file = path.join(root, 'test.webp'), log = path.join(root, 'events.jsonl');
  await fs.writeFile(file, webp(false));
  const input = { hook_event_name: 'PreToolUse', tool_name: 'view_image', session_id: 'synthetic-test', turn_id: 'turn', tool_use_id: 'call', tool_input: { path: file } };
  assert.deepEqual(await auditHook(input, log), {});
  const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(96, 16); png.writeUInt32BE(64, 20);
  await fs.writeFile(file, png);
  assert.equal((await auditHook(input, log)).hookSpecificOutput.permissionDecision, 'deny');
  const exact = path.join(root, 'exact.png'); await fs.writeFile(exact, png);
  assert.deepEqual(await auditHook({ ...input, tool_input: { path: exact } }, log), {});
  assert.deepEqual(await fs.readFile(exact), png);
  const records = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 3); assert.equal(records[0].compression, 'lossy');
  assert.equal(records[2].compression, 'lossless');
  assert.equal(JSON.stringify(records).includes('base64'), false);
  assert.deepEqual(await auditHook({ ...input, tool_input: { path: file, environment_id: 'remote' } }, log), {});
  await fs.unlink(file); await fs.unlink(exact); await fs.unlink(log); await fs.rmdir(root);
});

test('unexpected filesystem errors are not converted to successful empty diagnostics', async () => {
  await assert.rejects(auditHook({ hook_event_name: 'PreToolUse', tool_name: 'view_image', tool_input: { path: os.tmpdir() } }, path.join(os.tmpdir(), 'unused-image-audit.jsonl')), /EISDIR|EPERM/);
});

test('rollout diagnostic finds lossless WebP, skips mirrors and compaction, labels pairing as candidates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-delivery-rollout-'));
  const filename = path.join(root, 'rollout.jsonl');
  const payload = { type: 'custom_tool_call_output', call_id: 'call', output: [{ type: 'input_image', image_url: 'data:image/webp;base64,' + webp(true).toString('base64') }] };
  await fs.writeFile(filename, [
    { timestamp: '2026-11-04T05:00:00Z', type: 'event_msg', payload },
    { timestamp: '2026-11-04T05:00:00Z', type: 'compacted', payload },
    { timestamp: '2026-11-04T05:00:00Z', type: 'response_item', payload },
  ].map(JSON.stringify).join('\n') + '\n', 'utf8');
  const result = await auditRollout(filename, '2026-11-04T04:59:00Z', [{ path: 'source.webp', format: 'webp', compression: 'lossy', width: 192, height: 128 }]);
  assert.equal(result.images.length, 1); assert.equal(result.losslessWebPObserved, true);
  assert.deepEqual(result.images[0].possibleReencodedSources, ['source.webp']);
  assert.match(result.pairing, /not proof/);
  assert.equal((await auditRollout(filename, '2026-11-04T05:01:00Z')).images.length, 0);
  await fs.unlink(filename); await fs.rmdir(root);
});
