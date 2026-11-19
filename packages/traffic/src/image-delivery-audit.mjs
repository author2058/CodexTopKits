import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectImage(data) {
  const result = { bytes: data.length };
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { ...result, format: 'png', compression: 'lossless', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    let dimensions = {};
    for (let offset = 12; offset + 8 <= data.length;) {
      const type = data.toString('ascii', offset, offset + 4);
      const size = data.readUInt32LE(offset + 4), body = offset + 8;
      if (body + size > data.length) throw new Error('Truncated WebP chunk');
      if (type === 'VP8X') dimensions = { width: 1 + data.readUIntLE(body + 4, 3), height: 1 + data.readUIntLE(body + 7, 3) };
      if (type === 'VP8L') {
        const bits = data.readUInt32LE(body + 1);
        return { ...result, format: 'webp', compression: 'lossless', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (type === 'VP8 ') return { ...result, format: 'webp', compression: 'lossy', width: data.readUInt16LE(body + 6) & 0x3fff, height: data.readUInt16LE(body + 8) & 0x3fff };
      offset = body + size + (size & 1);
    }
    return { ...result, format: 'webp', compression: 'unknown', ...dimensions };
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    for (let offset = 2; offset + 4 < data.length;) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { ...result, format: 'jpeg', compression: 'lossy', width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      const size = data.readUInt16BE(offset + 2);
      if (size < 2) throw new Error('Invalid JPEG segment');
      offset += 2 + size;
    }
    return { ...result, format: 'jpeg', compression: 'lossy' };
  }
  return { ...result, format: 'unknown', compression: 'unknown' };
}

export async function inspectFile(filename) {
  const [data, stat] = await Promise.all([fs.readFile(filename), fs.stat(filename)]);
  return { path: filename, mtimeMs: stat.mtimeMs, ...inspectImage(data) };
}

function extensionFormat(filename) {
  return ({ '.png': 'png', '.webp': 'webp', '.jpg': 'jpeg', '.jpeg': 'jpeg' })[path.extname(filename).toLowerCase()];
}

export async function auditHook(input, logFile) {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'view_image') return {};
  const filename = input.tool_input?.path;
  if (typeof filename !== 'string') return {};
  // Paths in a remote executor are not host-local; never inspect a same-named local file.
  if (input.tool_input.environment_id) return {};
  const resolved = path.resolve(input.cwd || process.cwd(), filename);
  let image;
  try { image = await inspectFile(resolved); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const expected = extensionFormat(filename);
  const mismatch = Boolean(expected && image.format !== 'unknown' && expected !== image.format);
  const record = { ts: new Date().toISOString(), event: 'image-source', session_id: input.session_id, turn_id: input.turn_id, tool_use_id: input.tool_use_id, ...image, extensionFormat: expected, mismatch };
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.appendFile(logFile, JSON.stringify(record) + '\n', 'utf8');
  if (!mismatch) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `图片文件名表示 ${expected}，实际内容是 ${image.format}。请按实际编码修正扩展名，或从原始像素重新导出；不要只改后缀冒充另一种格式。` } };
}

function* imageUrls(value) {
  if (typeof value !== 'object' || value === null) return;
  if (value.type === 'image' && typeof value.data === 'string') yield `data:${value.mimeType};base64,${value.data}`;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'image_url') {
      const url = typeof child === 'string' ? child : child?.url;
      if (typeof url === 'string' && url.startsWith('data:')) yield url;
    } else if (typeof child === 'object') yield* imageUrls(child);
  }
}

export async function auditRollout(filename, after = '', sources = []) {
  const images = [];
  const lines = createInterface({ input: createReadStream(filename, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type !== 'response_item' || (after && record.timestamp < after)) continue;
    if (!['function_call_output', 'custom_tool_call_output'].includes(record.payload?.type)) continue;
    for (const url of imageUrls(record.payload)) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (!match) continue;
      const image = inspectImage(Buffer.from(match[2], 'base64'));
      const candidates = image.format === 'webp' && image.compression === 'lossless'
        ? sources.filter(source => source.format === 'webp' && source.compression === 'lossy' && source.width >= image.width && source.height >= image.height).map(source => source.path) : [];
      images.push({ timestamp: record.timestamp, itemId: record.payload.id, callId: record.payload.call_id, mime: match[1], ...image, possibleReencodedSources: candidates });
    }
  }
  return { rollout: filename, after, sources, images, losslessWebPObserved: images.some(image => image.format === 'webp' && image.compression === 'lossless'), pairing: 'Candidates are not proof of a call pairing; compare timestamps, tool call, dimensions and the original source.' };
}

async function main(args) {
  if (args[0] === 'hook') {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    const log = args[1] || path.join(process.env.USERPROFILE, '.codex', 'state', 'image-delivery', 'events.jsonl');
    console.log(JSON.stringify(await auditHook(JSON.parse(raw), log)));
  } else if (args[0] === 'inspect') {
    console.log(JSON.stringify(await Promise.all(args.slice(1).map(inspectFile)), null, 2));
  } else if (args[0] === 'rollout') {
    const afterIndex = args.indexOf('--after');
    const sourceFiles = args.flatMap((value, index) => value === '--source' ? [args[index + 1]] : []);
    console.log(JSON.stringify(await auditRollout(args[1], afterIndex < 0 ? '' : args[afterIndex + 1], await Promise.all(sourceFiles.map(inspectFile))), null, 2));
  } else throw new Error('Use: inspect FILE... | hook [LOG] | rollout FILE [--after ISO] [--source FILE]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
