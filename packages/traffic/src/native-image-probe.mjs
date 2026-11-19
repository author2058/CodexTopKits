// A loopback-only Responses stub: inspect actual native request images, never call a model.
import fs from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import zlib from 'node:zlib';
import { inspectFile, inspectImage } from './image-delivery-audit.mjs';

export async function captureNativeImageRequest({ executable, outputDirectory, filenames, unifiedImageBudget, signal }) {
if (!executable || !outputDirectory || !filenames.length) throw new Error('Pass CODEX_EXE OUTPUT_DIRECTORY IMAGE...');
signal?.throwIfAborted();
await fs.mkdir(outputDirectory, { recursive: true });
const nativeState = path.join(outputDirectory, 'native-test-state');
await fs.mkdir(nativeState, { recursive: true });
const sourceBytes = new Map(await Promise.all(filenames.map(async name => [name, await fs.readFile(name)])));
const sources = await Promise.all(filenames.map(inspectFile));
const requests = [];
const controlRequests = [];
let handlerError, child;

function* urls(value) {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'image_url' && typeof child === 'string' && child.startsWith('data:')) yield child;
    else if (typeof child === 'object') yield* urls(child);
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.headers.authorization) throw new Error('The isolated native probe unexpectedly sent authorization.');
    if (request.method === 'GET' && pathname === '/v1/models') {
      controlRequests.push({ method: request.method, path: request.url });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ models: [], data: [] }));
      return;
    }
    if (request.method !== 'POST' || pathname !== '/v1/responses') throw new Error(`Unexpected test request: ${request.method} ${request.url}`);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let bytes = Buffer.concat(chunks);
    const encoding = request.headers['content-encoding'];
    if (encoding === 'gzip') bytes = zlib.gunzipSync(bytes);
    else if (encoding === 'zstd' && zlib.zstdDecompressSync) bytes = zlib.zstdDecompressSync(bytes);
    else if (encoding && encoding !== 'identity') throw new Error(`Unsupported request compression: ${encoding}`);
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const images = [...urls(body.input)].map(url => {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (!match) throw new Error('Unexpected inline image URL');
      const data = Buffer.from(match[2], 'base64');
      return { mime: match[1], ...inspectImage(data), byteIdenticalSources: [...sourceBytes].filter(([, original]) => original.equals(data)).map(([filename]) => filename) };
    });
    requests.push({ ts: new Date().toISOString(), path: request.url, nativeVersion: request.headers.version ?? null, contentEncoding: encoding || 'identity', jsonBytes: bytes.length, images });
    const output = [{ id: 'msg_local_image_test', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Local image transport test complete.', annotations: [] }] }];
    const result = { id: `resp_local_image_test_${requests.length}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      ...output.map((item, index) => ({ type: 'response.output_item.done', output_index: index, item })),
      { type: 'response.completed', response: result },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  } catch (error) { handlerError = error; response.writeHead(500); response.end(error.message); child?.kill(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '--json', '-s', 'read-only',
  '-c', 'hooks.enabled=false', '-c', 'analytics.enabled=false', '-c', 'otel.exporter="none"', '-c', 'otel.trace_exporter="none"',
  '-c', 'model_provider="image_audit"', '-m', 'gpt-6.1-sol',
  '-c', `model_providers.image_audit={name="Local image audit",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
  ...(unifiedImageBudget === undefined ? [] : ['-c', `features.unified_image_budget=${unifiedImageBudget}`]),
  ...filenames.flatMap(filename => ['-i', filename]), '--', 'Local image delivery fixture. Reply only with a short completion message.'];
// Set the child's actual Codex state location, without changing the user's environment or caches.
const environment = { ...process.env, CODEX_HOME: nativeState, NO_PROXY: '127.0.0.1,localhost' };
for (const key of Object.keys(environment)) {
  if (/^(CODEX_APP_SERVER_OPENAI_BASE_URL|CODEX_CA_CERTIFICATE|SSL_CERT_FILE|SSL_CERT_DIR|OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|(http|https|all)_proxy|no_proxy)$/i.test(key)) delete environment[key];
}
environment.NO_PROXY = '127.0.0.1,localhost';
child = spawn(executable, args, { cwd: outputDirectory, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const stopOwnedProbe = () => child.kill();
process.once('exit', stopOwnedProbe);
signal?.addEventListener('abort', stopOwnedProbe, { once: true });
if (signal?.aborted) stopOwnedProbe();
let stdout = '', stderr = '', timedOut = false;
child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { stdout += data; });
child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data; });
// This bounds only the deterministic test process; it is not a production readiness gate.
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
let exitCode;
try { exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
finally {
  clearTimeout(timer); process.removeListener('exit', stopOwnedProbe); signal?.removeEventListener('abort', stopOwnedProbe);
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(path.join(outputDirectory, 'native-request.stdout.jsonl'), stdout, 'utf8');
await fs.writeFile(path.join(outputDirectory, 'native-request.stderr.txt'), stderr, 'utf8');
const finalImages = requests.at(-1)?.images || [];
const comparisons = finalImages.length === sources.length ? sources.map((source, index) => {
  const sent = finalImages[index];
  return { source: source.path, sourceBytes: source.bytes, sentBytes: sent.bytes, sizeMultiplier: sent.bytes / source.bytes, sourceCompression: source.compression, sentCompression: sent.compression, sourceSize: [source.width, source.height], sentSize: [sent.width, sent.height], byteIdentical: sent.byteIdenticalSources.includes(source.path) };
}) : [];
const report = { testedAt: new Date().toISOString(), nativeExecutable: executable, isolatedNativeState: nativeState, unifiedImageBudget: unifiedImageBudget ?? 'default', loopbackOnly: true, exitCode, timedOut, handlerError: handlerError?.stack, sources, controlRequests, requests, comparisons };
await fs.writeFile(path.join(outputDirectory, 'native-request-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
signal?.throwIfAborted();
if (handlerError || timedOut || exitCode !== 0 || requests.length !== 1 || finalImages.length !== filenames.length) {
  throw new Error(`Native image probe failed: ${handlerError?.message || (timedOut ? 'test process exceeded its 60-second budget' : `exit=${exitCode}, requests=${requests.length}, images=${finalImages.length}/${filenames.length}`)}\n${stderr}`, { cause: handlerError });
}
return report;
}

