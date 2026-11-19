import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTransformRouter } from '../src/transform-router.mjs';
import { createImageReferenceTransform } from '../src/image-reference-transform.mjs';

test('updates wait for in-flight transforms without interrupting or ignoring cancelled callers', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const router = createTransformRouter(async data => { await gate; return 'old:' + data; });
  const first = router.apply('first', {}), update = router.replace(async () => async data => 'new:' + data);
  const cancel = new AbortController(), cancelled = router.apply('cancelled', { signal: cancel.signal }); cancel.abort(new Error('caller cancelled'));
  await assert.rejects(cancelled, /caller cancelled/);
  const later = router.apply('later', {}); release();
  assert.equal(await first, 'old:first'); await update; assert.equal(await later, 'new:later');
});

test('failed updates report their error while the existing transform stays usable', async () => {
  const router = createTransformRouter(async data => 'original:' + data), failure = new Error('bad backend');
  await assert.rejects(router.replace(async () => { throw failure; }), error => error === failure);
  assert.equal(await router.apply('request', {}), 'original:request');
});

test('replacing the backend reuses the completed image cache', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-image-swap-')); t.after(() => fs.rm(directory, { recursive: true }));
  const cachePath = path.join(directory, 'cache.json'); let uploads = 0;
  const factory = () => createImageReferenceTransform({ cachePath, upload: async () => 'file_' + ++uploads });
  const router = createTransformRouter(await factory()), data = Buffer.from(JSON.stringify({ input: [{ type: 'message', content: [{ type: 'input_image', image_url: 'data:image/webp;base64,YQ==' }] }] }));
  const context = { path: '/backend-api/codex/responses', transport: 'websocket', headers: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture' } };
  assert.equal(JSON.parse(await router.apply(data, context)).input[0].content[0].file_id, 'file_1');
  await router.replace(factory); assert.equal(JSON.parse(await router.apply(data, context)).input[0].content[0].file_id, 'file_1'); assert.equal(uploads, 1);
});

test('an aborted caller cannot race an unfinished image cache write during an update', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cdtk-image-drain-')); t.after(() => fs.rm(directory, { recursive: true }));
  const cachePath = path.join(directory, 'cache.json'); let release, uploads = 0, updated = false;
  const upload = async () => { uploads++; await new Promise(resolve => { release = resolve; }); return 'file_1'; };
  const factory = () => createImageReferenceTransform({ cachePath, upload });
  const router = createTransformRouter(await factory()), cancel = new AbortController(), data = Buffer.from(JSON.stringify({ input: [{ type: 'message', content: [{ type: 'input_image', image_url: 'data:image/webp;base64,YQ==' }] }] }));
  const context = { path: '/backend-api/codex/responses', transport: 'websocket', headers: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture' }, signal: cancel.signal };
  const request = router.apply(data, context); cancel.abort(new Error('cancelled')); await assert.rejects(request, /cancelled/);
  const update = router.replace(factory).then(() => { updated = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(updated, false);
  release(); await update; const result = await router.apply(data, { ...context, signal: undefined });
  assert.equal(JSON.parse(result).input[0].content[0].file_id, 'file_1'); assert.equal(uploads, 1);
});
