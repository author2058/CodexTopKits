import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { createImageReferenceTransform, uploadImage } from '../src/image-reference-transform.mjs';
import { ModelTrafficMeter } from '../src/model-traffic.mjs';

const headers = { authorization: 'Bearer fixture-token', 'chatgpt-account-id': 'fixture-workspace' };
const inline = value => ({ type: 'input_image', image_url: 'data:image/webp;base64,' + Buffer.from(value).toString('base64') });
const request = () => ({ type: 'response.create', input: [
  { type: 'message', role: 'user', content: [inline('snapshot-A'), { type: 'input_text', text: 'current.webp' }] },
  { type: 'function_call_output', call_id: 'one', output: [inline('snapshot-A'), inline('snapshot-B')] },
  { type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_existing' }] },
  { type: 'custom_tool_call_output', call_id: 'image-view', output: [inline('snapshot-B')] },
] });

test('typed message/tool image snapshots deduplicate by bytes and account, not overwritten filenames', async () => {
  const uploads = [], events = [];
  const transform = await createImageReferenceTransform({ upload: async item => { uploads.push(item); return 'file_' + uploads.length; }, log: async event => events.push(event) });
  const input = Buffer.from(JSON.stringify(request()));
  const output = await transform(input, { path: '/backend-api/codex/responses', transport: 'websocket', headers });
  const result = JSON.parse(output);
  assert.equal(uploads.length, 2);
  assert.equal(result.input[0].content[0].file_id, 'file_1');
  assert.equal(result.input[1].output[0].file_id, 'file_1');
  assert.equal(result.input[1].output[1].file_id, 'file_2');
  assert.equal(result.input[2].content[0].file_id, 'file_existing');
  assert.equal(result.input[3].output[0].file_id, 'file_2');
  assert.equal(result.input[0].content[1].text, 'current.webp');
  await transform(input, { path: '/backend-api/codex/responses', transport: 'websocket', headers });
  assert.equal(uploads.length, 2);
  await transform(input, { path: '/backend-api/codex/responses', transport: 'websocket', headers: { ...headers, 'chatgpt-account-id': 'other-workspace' } });
  assert.equal(uploads.length, 4);
  assert.ok(!JSON.stringify(events).includes('fixture-token'));
});

test('disabled image deduplication preserves the request and still identifies its traffic', async () => {
  let uploads = 0, identified; const totals = {};
  const transform = await createImageReferenceTransform({ enabled: false, upload: async () => { uploads++; return 'file_forbidden'; } });
  const input = Buffer.from(JSON.stringify(request())), meter = { identify(value) { identified = value; }, add(name, value) { totals[name] = value; } };
  const output = await transform(input, { path: '/backend-api/codex/responses', transport: 'websocket', headers, meter });
  assert.equal(output, input); assert.equal(uploads, 0); assert.equal(identified.type, 'response.create'); assert.equal(totals.logicalBefore, input.length); assert.equal(totals.logicalAfter, input.length);
});

test('references refresh at seven days, share the upload and persist the new ID', async t => {
  const start = Date.parse('2026-11-07T00:00:00Z'), lifetime = 7 * 24 * 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const directory = await mkdtemp(join(tmpdir(), 'codex-image-reference-test-'));
  const cachePath = join(directory, 'cache.json');
  await writeFile(cachePath, JSON.stringify({ version: 1, entries: {} }), 'utf8');
  t.after(async () => { await unlink(cachePath); await rmdir(directory); });
  let uploads = 0, releaseRefresh;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  const upload = async () => { uploads++; if (uploads === 2) await refreshGate; return 'file_' + uploads; };
  const transform = await createImageReferenceTransform({ cachePath, upload });
  const data = Buffer.from(JSON.stringify({ input: [{ type: 'message', content: [inline('snapshot')] }] }));
  const context = { path: '/backend-api/codex/responses', transport: 'websocket', headers };
  const fileId = value => JSON.parse(value).input[0].content[0].file_id;
  assert.equal(fileId(await transform(data, context)), 'file_1');
  t.mock.timers.setTime(start + lifetime - 1);
  assert.equal(fileId(await transform(data, context)), 'file_1');
  assert.equal(uploads, 1);
  t.mock.timers.setTime(start + lifetime);
  const first = transform(data, context), second = transform(data, context);
  assert.equal(uploads, 2);
  releaseRefresh();
  assert.deepEqual((await Promise.all([first, second])).map(fileId), ['file_2', 'file_2']);
  assert.equal(uploads, 2);
  const stored = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.deepEqual(Object.values(stored.entries).map(entry => [entry.fileId, entry.createdAt]), [['file_2', new Date(start + lifetime).toISOString()]]);
  const reloaded = await createImageReferenceTransform({ cachePath, upload });
  assert.equal(fileId(await reloaded(data, context)), 'file_2');
  assert.equal(uploads, 2);
  Object.values(stored.entries)[0].createdAt = 'invalid';
  await writeFile(cachePath, JSON.stringify(stored), 'utf8');
  const invalid = await createImageReferenceTransform({ cachePath, upload });
  await assert.rejects(invalid(data, context), /Invalid image reference cache creation time/);
  assert.equal(uploads, 2);
});

test('an expired reference does not fall back to the old ID when reupload fails', async t => {
  const start = Date.parse('2026-11-07T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  let uploads = 0;
  const transform = await createImageReferenceTransform({ upload: async () => {
    uploads++;
    if (uploads > 1) throw new Error('refresh upload failed');
    return 'file_original';
  } });
  const data = Buffer.from(JSON.stringify({ input: [{ type: 'message', content: [inline('snapshot')] }] }));
  const context = { path: '/backend-api/codex/responses', transport: 'websocket', headers };
  await transform(data, context);
  t.mock.timers.setTime(start + 7 * 24 * 60 * 60 * 1000);
  await assert.rejects(transform(data, context), /refresh upload failed/);
  await assert.rejects(transform(data, context), /refresh upload failed/);
  assert.equal(uploads, 3);
});

test('expired images absent from the request remain unchanged', async t => {
  const start = Date.parse('2026-11-07T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const directory = await mkdtemp(join(tmpdir(), 'codex-image-reference-test-'));
  const cachePath = join(directory, 'cache.json');
  await writeFile(cachePath, JSON.stringify({ version: 1, entries: {} }), 'utf8');
  t.after(async () => { await unlink(cachePath); await rmdir(directory); });
  let uploads = 0;
  const transform = await createImageReferenceTransform({ cachePath, upload: async () => 'file_' + ++uploads });
  const data = value => Buffer.from(JSON.stringify({ input: [{ type: 'message', content: [inline(value)] }] }));
  const context = { path: '/backend-api/codex/responses', transport: 'websocket', headers };
  await transform(data('needed'), context);
  await transform(data('not-in-request'), context);
  const before = JSON.parse(await readFile(cachePath, 'utf8'));
  const other = Object.values(before.entries).find(entry => entry.fileId === 'file_2');
  t.mock.timers.setTime(start + 7 * 24 * 60 * 60 * 1000);
  const result = JSON.parse(await transform(data('needed'), context));
  const after = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(result.input[0].content[0].file_id, 'file_3');
  assert.equal(uploads, 3);
  assert.deepEqual(Object.values(after.entries).find(entry => entry.fileId === 'file_2'), other);
});

test('a new unrecognized image container is visible and cannot silently replay base64', async () => {
  const transform = await createImageReferenceTransform({ upload: async () => 'file_fixture' });
  const data = Buffer.from(JSON.stringify({ input: [{ type: 'future_tool_output', output: [inline('snapshot')] }] }));
  await assert.rejects(transform(data, { path: '/backend-api/codex/responses', transport: 'websocket', headers }), /Unrecognized native image container/);
});

test('HTTP zstd remains zstd and upload failures never silently replay base64', async () => {
  const transform = await createImageReferenceTransform({ upload: async () => 'file_fixture' });
  const output = await transform(zstdCompressSync(Buffer.from(JSON.stringify(request()))), { path: '/backend-api/codex/responses', transport: 'http', headers: { ...headers, 'content-encoding': 'zstd' } });
  const result = JSON.parse(zstdDecompressSync(output));
  assert.equal(result.input[1].output[1].file_id, 'file_fixture');
  assert.ok(!JSON.stringify(result).includes('data:image'));
  const failed = await createImageReferenceTransform({ upload: async () => { throw new Error('upload fixture failure'); } });
  await assert.rejects(failed(Buffer.from(JSON.stringify(request())), { path: '/backend-api/codex/responses', transport: 'websocket', headers }), /upload fixture failure/);
});

test('native three-stage file upload never sends OAuth to blob host or follows redirects', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (calls.length === 1) return Response.json({ file_id: 'file_fixture', upload_url: 'https://blob.example.test/signed?signature=fixture' });
    if (calls.length === 2) return new Response(null, { status: 201 });
    return Response.json({ status: 'success' });
  };
  assert.equal(await uploadImage({ bytes: Buffer.from('snapshot'), mime: 'image/webp', sha256: 'fixture-hash', headers }, { fetcher }), 'file_fixture');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers.authorization, headers.authorization);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers['chatgpt-account-id'], undefined);
  assert.ok(calls.every(call => call.redirect === 'error'));
});

test('cancelling one request preserves a shared upload; cancelling its last consumer aborts it', async () => {
  let finish, uploadSignal, uploads = 0;
  const transform = await createImageReferenceTransform({ upload: async ({ signal }) => {
    uploads++; uploadSignal = signal;
    return new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } });
  const data = Buffer.from(JSON.stringify({ input: [{ type: 'message', content: [inline('same-snapshot')] }] }));
  const first = new AbortController(), second = new AbortController();
  const context = signal => ({ path: '/backend-api/codex/responses', transport: 'websocket', headers, signal });
  const a = transform(data, context(first.signal)), b = transform(data, context(second.signal));
  first.abort(new DOMException('first stopped', 'AbortError'));
  await assert.rejects(a, /first stopped/);
  assert.equal(uploads, 1); assert.equal(uploadSignal.aborted, false);
  finish('file_shared'); await b;
  const last = new AbortController();
  const different = Buffer.from(JSON.stringify({ input: [{ type: 'message', content: [inline('other-snapshot')] }] }));
  const c = transform(different, context(last.signal));
  last.abort(new DOMException('last stopped', 'AbortError'));
  await assert.rejects(c, /last stopped/);
  assert.equal(uploadSignal.aborted, true);
});

test('logical JSON pairs with the actual compressed HTTP body; shared uploads are charged only once', async () => {
  const events = [];
  const meter = new ModelTrafficMeter({ headers: { 'thread-id': 'thread-one' }, endpoint: 'https://example.test/responses', transport: 'http', log: async event => events.push(event) });
  const other = new ModelTrafficMeter({ headers: { 'thread-id': 'thread-two' }, endpoint: 'https://example.test/responses', transport: 'http', log: async event => events.push(event) });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let uploads = 0;
  const transform = await createImageReferenceTransform({ upload: async ({ bytes, meter: owner }) => { uploads++; await gate; owner.add('imageUploadBytes', bytes.length); return 'file_shared'; } });
  const raw = Buffer.from(JSON.stringify(request())), data = zstdCompressSync(raw);
  const context = meter => ({ path: '/backend-api/codex/responses', transport: 'http', headers: { ...headers, 'content-encoding': 'zstd' }, meter });
  const a = transform(data, context(meter)), b = transform(data, context(other));
  release(); const [output] = await Promise.all([a, b]);
  assert.equal(uploads, 2); // two unique image byte sequences, not two consumers
  assert.equal(meter.record.logicalBefore, raw.length);
  assert.equal(meter.record.logicalAfter, zstdDecompressSync(output).length);
  assert.equal(meter.record.imageUploadBytes + other.record.imageUploadBytes, Buffer.byteLength('snapshot-A') + Buffer.byteLength('snapshot-B'));
  meter.finish(true); other.finish(true);
});
