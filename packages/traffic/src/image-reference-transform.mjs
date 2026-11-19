import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { zstdCompress, zstdDecompress } from 'node:zlib';

const compress = promisify(zstdCompress), decompress = promisify(zstdDecompress);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const imageReferenceLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export async function uploadImage({ bytes, mime, sha256: hash, headers, signal, meter }, { fetcher = fetch, log = async () => {} } = {}) {
  // Reuse this request's native account credentials, never the proxy operator's account.
  const apiHeaders = { 'content-type': 'application/json' };
  for (const key of ['authorization', 'chatgpt-account-id', 'user-agent', 'originator', 'version', 'x-openai-account-routing-override']) {
    if (headers[key]) apiHeaders[key] = headers[key];
  }
  const post = async (path, body) => {
    const response = await fetcher('https://chatgpt.com/backend-api' + path, {
      method: 'POST', headers: apiHeaders, body: JSON.stringify(body), redirect: 'error', signal,
    });
    await log({ event: 'file-api-response', path, status: response.status, threadId: meter?.record.threadId ?? null, trafficId: meter?.record.id ?? null });
    if (!response.ok) throw new Error(`Image file API ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const extension = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/gif': 'gif' }[mime];
  if (!extension) throw new Error('Unsupported inline image MIME: ' + mime);
  const created = await post('/files', { file_name: `codex-image-${hash}.${extension}`, file_size: bytes.length, mime_type: mime, use_case: 'codex', store_in_library: false });
  if (typeof created.file_id !== 'string' || !created.file_id.startsWith('file_')) throw new Error('File creation returned no file ID.');
  const url = new URL(created.upload_url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('File creation returned an invalid upload URL.');
  // Blob credentials come exclusively from the signed upload response; no native OAuth headers.
  const uploaded = await fetcher(url, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': mime, ...created.upload_headers }, body: bytes, redirect: 'error', signal });
  // A successful response confirms the upload body; failed/partial transport is
  // not fabricated from the planned body size. Shared in-flight uploads belong
  // to the initiating request, and cache hits add no new upload bytes.
  if (uploaded.ok) meter?.add('imageUploadBytes', bytes.length);
  await log({ event: 'image-upload', host: url.hostname, endpoint: url.origin + url.pathname, bytes: bytes.length, status: uploaded.status, sha256: hash,
    threadId: meter?.record.threadId ?? null, trafficId: meter?.record.id ?? null });
  if (!uploaded.ok) throw new Error('Image blob upload: HTTP ' + uploaded.status);
  await uploaded.arrayBuffer();
  const finalized = await post('/files/' + encodeURIComponent(created.file_id) + '/uploaded', {});
  if (finalized.status !== 'success') throw new Error('Image file not ready: ' + String(finalized.status));
  return created.file_id;
}

export async function createImageReferenceTransform({ cachePath, upload = uploadImage, log = async () => {}, enabled = true } = {}) {
  let entries = {};
  if (cachePath) {
    try {
      const cache = JSON.parse(await readFile(cachePath, 'utf8'));
      if (cache.version !== 1) throw new Error('Unsupported image reference cache version.');
      entries = cache.entries;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const inFlight = new Map();
  let saving = Promise.resolve();
  const reference = async (image, headers, signal, meter) => {
    signal?.throwIfAborted();
    if (!headers.authorization?.startsWith('Bearer ') || !headers['chatgpt-account-id']) throw new Error('Image upload requires native account credentials.');
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.image_url);
    if (!match) throw new Error('Unrecognized native inline image data URL.');
    const bytes = Buffer.from(match[2], 'base64'), hash = sha256(bytes);
    // shortcut: token-scoped cache; use a verified stable principal if refresh-driven reuploads become material.
    const scope = sha256(headers['chatgpt-account-id'] + '\n' + headers.authorization);
    const key = scope + ':' + hash;
    const cached = entries[key];
    if (cached) {
      const createdAt = Date.parse(cached.createdAt);
      if (!Number.isFinite(createdAt)) throw new Error('Invalid image reference cache creation time.');
      if (Date.now() - createdAt < imageReferenceLifetimeMs) {
        meter?.add('cacheHits', 1);
        await log({ event: 'image-cache-hit', sha256: hash, bytes: bytes.length, fileId: cached.fileId });
        return cached.fileId;
      }
    }
    if (!inFlight.has(key)) {
      const controller = new AbortController();
      const entry = { controller, consumers: 0, complete: false };
      entry.promise = (async () => {
        const fileId = await upload({ bytes, mime: match[1], sha256: hash, headers, signal: controller.signal, meter }, { log });
        entries[key] = { fileId, sha256: hash, bytes: bytes.length, mime: match[1], createdAt: new Date().toISOString() };
        if (cachePath) {
          saving = saving.then(() => writeFile(cachePath, JSON.stringify({ version: 1, entries }) + '\n', 'utf8'));
          await saving;
        }
        return fileId;
      })().finally(() => { entry.complete = true; if (inFlight.get(key) === entry) inFlight.delete(key); });
      inFlight.set(key, entry);
    }
    const entry = inFlight.get(key);
    entry.consumers++;
    let onAbort;
    try {
      const aborted = signal ? new Promise((_, reject) => { onAbort = () => reject(signal.reason); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }) : new Promise(() => {});
      return await Promise.race([entry.promise, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      entry.consumers--;
      if (!entry.complete && entry.consumers === 0) entry.controller.abort(signal?.reason);
    }
  };
  const transform = async (data, { path, headers, transport, signal, meter }) => {
    signal?.throwIfAborted();
    if (!/^\/backend-api\/codex\/responses(?:\/compact)?$/.test(path) || !data.length) return data;
    const encoding = transport === 'http' ? headers['content-encoding'] : undefined;
    if (encoding && encoding !== 'zstd' && encoding !== 'identity') throw new Error('Unsupported model request encoding: ' + encoding);
    const decoded = encoding === 'zstd' ? await decompress(data) : data;
    const request = JSON.parse(decoded.toString('utf8'));
    meter?.identify(request);
    meter?.add('logicalBefore', decoded.length);
    if (!enabled) { meter?.add('logicalAfter', decoded.length); return data; }
    let replacements = 0, toolImages = 0, messageImages = 0;
    for (const item of request.input ?? []) {
      // Native user images and tool-result images have distinct typed containers.
      const content = item.type === 'message' ? item.content : ['function_call_output', 'custom_tool_call_output'].includes(item.type) ? item.output : null;
      if (!Array.isArray(content)) continue;
      for (const image of content) {
        if (image.type !== 'input_image' || typeof image.image_url !== 'string' || !image.image_url.startsWith('data:')) continue;
        image.file_id = await reference(image, headers, signal, meter);
        delete image.image_url;
        replacements++;
        if (item.type === 'message') messageImages++; else toolImages++;
      }
    }
    if (decoded.includes(Buffer.from('data:image/'))) {
      const shapes = [];
      const inspect = (value, path) => {
        if (!value || typeof value !== 'object') return;
        if (value.type === 'input_image' && value.image_url?.startsWith('data:')) shapes.push({ path, keys: Object.keys(value), type: value.type });
        for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') inspect(child, path + '.' + key);
      };
      inspect(request.input, 'input');
      if (shapes.length) {
        await log({ event: 'unmatched-image-shape', topKeys: Object.keys(request), shapes });
        throw new Error('Unrecognized native image container; no base64 fallback.');
      }
    }
    if (!replacements) { meter?.add('logicalAfter', decoded.length); return data; }
    const converted = Buffer.from(JSON.stringify(request), 'utf8');
    const output = encoding === 'zstd' ? await compress(converted) : converted;
    meter?.add('logicalAfter', converted.length); meter?.add('images', replacements);
    await log({ event: 'images-referenced', transport, images: replacements, toolImages, messageImages, jsonBefore: decoded.length, jsonAfter: converted.length, before: data.length, after: output.length });
    return output;
  };
  transform.drain = async () => {
    // Callers already receive upload failures; wait for their background cleanup before reusing the cache.
    await Promise.allSettled([...inFlight.values()].map(entry => entry.promise));
    await saving;
  };
  return transform;
}
