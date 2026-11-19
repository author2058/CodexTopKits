import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const IDENTIFIER = /^[A-Za-z0-9._-]{1,200}$/;
const DEFAULT_BLOCK_BYTES = 64 * 1024;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_ANCHOR_HARD_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_META_MAX_BYTES = 1024 * 1024;
const TARGETED_RECORD_MAX_BYTES = 2 * 1024 * 1024;
const RECORD_PREFIX_BYTES = 4096;
const MAX_DETAIL_ITEMS = 6;

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`Missing value for ${argument}.`);
    options[argument.slice(2)] = value;
  }
  const threadId = options['thread-id'];
  if (!IDENTIFIER.test(threadId || '')) throw new Error('--thread-id must be a valid Codex thread ID.');
  const upperBound = new Date(options['hook-observed-at'] || '');
  if (!Number.isFinite(upperBound.getTime())) throw new Error('--hook-observed-at must be an ISO timestamp.');
  const blockBytes = options['block-bytes'] === undefined ? DEFAULT_BLOCK_BYTES : Number(options['block-bytes']);
  const maxBytes = options['max-bytes'] === undefined ? DEFAULT_MAX_BYTES : Number(options['max-bytes']);
  const legacyHardMaxBytes = options['hard-max-bytes'] === undefined ? null : Number(options['hard-max-bytes']);
  const anchorHardMaxBytes = options['anchor-hard-max-bytes'] === undefined
    ? legacyHardMaxBytes ?? DEFAULT_ANCHOR_HARD_MAX_BYTES
    : Number(options['anchor-hard-max-bytes']);
  if (options['turn-hard-max-bytes'] !== undefined) throw new Error('--turn-hard-max-bytes is no longer supported; turn recovery uses exact-ID record lookup.');
  if (!Number.isInteger(blockBytes) || blockBytes < 4096 || blockBytes > 1024 * 1024) throw new Error('--block-bytes must be an integer from 4096 through 1048576.');
  if (!Number.isInteger(maxBytes) || maxBytes < blockBytes || maxBytes > 16 * 1024 * 1024) throw new Error('--max-bytes must be an integer from block-bytes through 16777216.');
  if (legacyHardMaxBytes !== null && (!Number.isInteger(legacyHardMaxBytes) || legacyHardMaxBytes < maxBytes || legacyHardMaxBytes > 16 * 1024 * 1024)) throw new Error('--hard-max-bytes must be an integer from max-bytes through 16777216.');
  if (!Number.isInteger(anchorHardMaxBytes) || anchorHardMaxBytes < maxBytes || anchorHardMaxBytes > 16 * 1024 * 1024) throw new Error('--anchor-hard-max-bytes must be an integer from max-bytes through 16777216.');
  const itemId = options['item-id'];
  if (itemId !== undefined && !IDENTIFIER.test(itemId)) throw new Error('--item-id must be a valid item ID.');
  const sessionsRoot = path.resolve(options['sessions-root'] || path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex'), 'sessions'));
  const rolloutPath = options.rollout ? path.resolve(options.rollout) : null;
  return { threadId, upperBound, blockBytes, maxBytes, anchorHardMaxBytes, itemId, sessionsRoot, rolloutPath };
}

async function readSessionMeta(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, SESSION_META_MAX_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const result = await handle.read(buffer, 0, length, 0);
    const newline = buffer.subarray(0, result.bytesRead).indexOf(0x0a);
    if (newline < 0) throw new Error(`Rollout session metadata exceeds ${SESSION_META_MAX_BYTES} bytes or has no newline: ${filePath}`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline)).replace(/\r$/u, '');
    let record;
    try { record = JSON.parse(text); }
    catch (error) { throw new Error(`Invalid rollout session metadata JSON: ${filePath}`, { cause: error }); }
    if (record?.type !== 'session_meta' || typeof record.payload?.id !== 'string') throw new Error(`First rollout record is not valid session metadata: ${filePath}`);
    const timestampMs = eventTime(record);
    if (timestampMs === null) throw new Error(`Rollout session metadata has an invalid timestamp: ${filePath}`);
    return { threadId: record.payload.id, timestampMs, timestamp: record.timestamp };
  } finally {
    await handle.close();
  }
}

async function assertRolloutThread(filePath, threadId) {
  const metadata = await readSessionMeta(filePath);
  if (metadata.threadId !== threadId) throw new Error(`Resolved rollout session metadata belongs to ${metadata.threadId}, not ${threadId}: ${filePath}`);
  return metadata;
}

async function findRolloutSegments(root, threadId, upperBound) {
  const filenameToken = threadId.toLowerCase();
  const pending = [root];
  const candidates = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().includes(filenameToken) && entry.name.toLowerCase().endsWith('.jsonl')) candidates.push(candidate);
    }
  }
  if (candidates.length === 0) throw new Error(`No rollout filename candidate was found for thread ${threadId}.`);
  const verified = [];
  const mismatched = [];
  for (const candidate of candidates) {
    const metadata = await readSessionMeta(candidate);
    if (metadata.threadId === threadId) verified.push({ filePath: candidate, ...metadata });
    else mismatched.push(`${candidate}=>${metadata.threadId}`);
  }
  const eligible = verified
    .filter((candidate) => candidate.timestampMs <= upperBound.getTime())
    .sort((left, right) => right.timestampMs - left.timestampMs || right.filePath.localeCompare(left.filePath));
  if (eligible.length > 0) return eligible;
  const mismatchDetail = mismatched.length > 0 ? ` Filename matches with different session metadata: ${mismatched.join('; ')}` : '';
  throw new Error(`No verified rollout segment for thread ${threadId} starts at or before ${upperBound.toISOString()}.${mismatchDetail}`);
}

function eventTime(record) {
  const parsed = Date.parse(record?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function turnIdOf(record) {
  const payload = record?.payload;
  return payload?.internal_chat_message_metadata_passthrough?.turn_id
    || payload?.turn_id
    || payload?.item?.turn_id
    || null;
}

function contextCompactionTurnIdOf(record) {
  if (record?.type !== 'event_msg' || record.payload?.type !== 'item_completed') return null;
  if (record.payload?.item?.type !== 'ContextCompaction') return null;
  return turnIdOf(record);
}

function textOfPayload(payload) {
  if (payload?.type === 'message') {
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    return blocks.map((block) => typeof block?.text === 'string' ? block.text : '').join('');
  }
  if (payload?.type?.endsWith('_call_output')) {
    if (typeof payload.output === 'string') return payload.output;
    const blocks = Array.isArray(payload.output) ? payload.output : [];
    return blocks.map((block) => typeof block?.text === 'string' ? block.text : '').join('');
  }
  return '';
}

function contentMetadata(text) {
  return text ? {
    length: Buffer.byteLength(text, 'utf8'),
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
  } : null;
}

function sourceThreadId(text) {
  const match = /^<codex_delegation>\s*<source_thread_id>([^<]+)<\/source_thread_id>/u.exec(text);
  return match?.[1]?.trim() || null;
}

function isInjectedContext(text) {
  if (/## My request for Codex:/u.test(text)) return false;
  return /^\s*(?:# AGENTS\.md instructions\b|<environment_context\b|<recommended_plugins\b|<app-context\b|<skills_instructions\b|<permissions instructions\b)/u.test(text);
}

function summarizeResponseItem(record) {
  if (record?.type !== 'response_item' || !record.payload) return null;
  const payload = record.payload;
  const timestamp = record.timestamp;
  const turnId = turnIdOf(record);
  const itemId = typeof payload.id === 'string' ? payload.id : null;
  if (payload.type === 'message') {
    const text = textOfPayload(payload);
    const content = contentMetadata(text);
    if (payload.role === 'user') return { timestamp, turnId, itemId, kind: isInjectedContext(text) ? 'context-input' : 'user-input', role: 'user', phase: null, status: payload.status || null, sourceThreadId: null, content };
    if (payload.role === 'assistant') return { timestamp, turnId, itemId, kind: 'agent-message', role: 'assistant', phase: payload.phase || null, status: payload.status || null, sourceThreadId: null, content };
  }
  if (payload.type?.endsWith('_call_output')) {
    const text = payload.type === 'function_call_output' ? textOfPayload(payload) : '';
    const sender = text ? sourceThreadId(text) : null;
    return { timestamp, turnId, itemId, callId: payload.call_id || null, kind: sender ? 'delegated-input' : 'tool-output', role: 'tool', phase: null, status: sender ? 'received' : 'returned', name: payload.name || null, namespace: payload.namespace || null, sourceThreadId: sender, content: sender ? contentMetadata(text) : null };
  }
  if (['custom_tool_call', 'function_call', 'mcp_tool_call'].includes(payload.type)) return { timestamp, turnId, itemId, callId: payload.call_id || null, kind: 'tool-call', role: 'assistant', phase: null, status: 'pending-output', protocolStatus: payload.status || null, name: payload.name || null, namespace: payload.namespace || null, sourceThreadId: null, content: null };
  if (payload.type === 'reasoning') return { timestamp, turnId, itemId, kind: 'model-activity', role: 'assistant', phase: 'reasoning', status: payload.status || null, sourceThreadId: null, content: null };
  return null;
}

function summarizeTurnEvent(record) {
  if (record?.type !== 'event_msg' || !record.payload) return null;
  const type = record.payload.type;
  const status = ['task_started', 'turn_started'].includes(type)
    ? 'running'
    : ['task_complete', 'turn_complete'].includes(type)
      ? record.payload.error != null ? 'failed' : 'completed'
      : ['task_interrupted', 'turn_interrupted', 'turn_aborted'].includes(type)
        ? 'interrupted'
        : null;
  if (!status) return null;
  return {
    timestamp: record.timestamp,
    turnId: turnIdOf(record),
    itemId: record.payload.id || null,
    kind: 'turn-status',
    role: 'runtime',
    phase: null,
    status,
    error: record.payload.error ?? null,
    sourceThreadId: null,
    content: null,
  };
}

function summarizeToolEvent(record) {
  if (record?.type !== 'event_msg' || !record.payload) return null;
  const payload = record.payload;
  const type = typeof payload.type === 'string' ? payload.type : '';
  if (!/(tool_call|exec_command|command_execution).*(begin|end|start|complete|failed)$/u.test(type)) return null;
  const status = /(end|complete)$/u.test(type) ? 'completed' : /failed$/u.test(type) ? 'failed' : 'running';
  return {
    timestamp: record.timestamp,
    turnId: turnIdOf(record),
    itemId: payload.call_id || payload.id || null,
    kind: 'tool-status',
    role: 'tool',
    phase: null,
    status,
    name: payload.invocation?.tool || payload.command || type,
    namespace: payload.invocation?.server || null,
    sourceThreadId: null,
    content: null,
  };
}

function detailFor(record, itemId) {
  if (record?.type !== 'response_item' || record.payload?.id !== itemId) return null;
  const summary = summarizeResponseItem(record);
  if (!summary) throw new Error(`Item ${itemId} is not a supported recovery item.`);
  return { ...summary, text: textOfPayload(record.payload) };
}

async function readRecoveryWindow(filePath, options) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    let position = stats.size;
    let remainder = Buffer.alloc(0);
    let bytesRead = 0;
    let lineCount = 0;
    let targetTurnId = null;
    let contextCompactionTurnId = null;
    let sawTargetTurn = false;
    let boundaryFound = false;
    let compaction = null;
    let readLimit = options.maxBytes;
    let completingSoftBoundaryRecord = false;
    let completedRecordBeyondInitial = false;
    let preAnchorRecordIncompleteAtHardLimit = false;
    const summaries = [];
    const afterAnchorSummaries = [];
    const afterAnchorTurnIds = new Set();
    while (position > 0 && bytesRead < readLimit && !boundaryFound) {
      const length = Math.min(options.blockBytes, position, readLimit - bytesRead);
      position -= length;
      const block = Buffer.allocUnsafe(length);
      const result = await handle.read(block, 0, length, position);
      if (result.bytesRead !== length) throw new Error('Rollout file changed during bounded recovery read.');
      const blockHasNewline = block.includes(0x0a);
      bytesRead += length;
      const combined = Buffer.concat([block, remainder]);
      const segments = [];
      let end = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] === 0x0a) {
          if (index + 1 < end) segments.push(combined.subarray(index + 1, end));
          end = index;
        }
      }
      remainder = combined.subarray(0, end);
      if (position === 0 && remainder.length > 0) { segments.push(remainder); remainder = Buffer.alloc(0); }
      for (const segment of segments) {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(segment).replace(/\r$/u, '');
        if (!text) continue;
        lineCount += 1;
        let record;
        try { record = JSON.parse(text); }
        catch (error) { throw new Error(`Invalid rollout JSON encountered within the bounded recovery window: ${error.message}`, { cause: error }); }
        const timestampMs = eventTime(record);
        if (timestampMs === null) continue;
        if (timestampMs > options.upperBound.getTime()) continue;
        const summary = summarizeResponseItem(record) || summarizeToolEvent(record) || summarizeTurnEvent(record);
        if (summary) summary.reverseOrder = lineCount;
        const turnId = turnIdOf(record);
        if (!compaction) {
          const completedCompactionTurnId = contextCompactionTurnIdOf(record);
          if (completedCompactionTurnId) contextCompactionTurnId = completedCompactionTurnId;
          if (record.type === 'compacted') {
            const payload = record.payload || {};
            compaction = {
              timestamp: record.timestamp,
              windowNumber: payload.window_number ?? null,
              windowId: payload.window_id ?? null,
              previousWindowId: payload.previous_window_id ?? null,
              firstWindowId: payload.first_window_id ?? null,
            };
            if (!targetTurnId && contextCompactionTurnId) targetTurnId = contextCompactionTurnId;
            continue;
          }
          if (turnId) afterAnchorTurnIds.add(turnId);
          if (summary) afterAnchorSummaries.push(summary);
          continue;
        }
        if (!targetTurnId && turnId) targetTurnId = turnId;
        if (targetTurnId && turnId === targetTurnId) {
          sawTargetTurn = true;
          if (summary) summaries.push(summary);
          const payloadType = record?.payload?.type;
          if (['task_started', 'turn_started'].includes(payloadType)) { boundaryFound = true; break; }
        } else if (sawTargetTurn && turnId && turnId !== targetTurnId) {
          boundaryFound = true;
          break;
        }
      }
      if (completingSoftBoundaryRecord) {
        if (blockHasNewline) {
          completingSoftBoundaryRecord = false;
          completedRecordBeyondInitial = true;
          if (!compaction) break;
        } else if (bytesRead >= options.anchorHardMaxBytes) {
          preAnchorRecordIncompleteAtHardLimit = true;
          break;
        } else if (bytesRead >= readLimit) {
          readLimit = Math.min(options.anchorHardMaxBytes, readLimit + options.blockBytes);
          continue;
        }
      }
      if (!compaction && bytesRead >= readLimit && position > 0 && remainder.length > 0) {
        if (readLimit < options.anchorHardMaxBytes) {
          completingSoftBoundaryRecord = true;
          readLimit = Math.min(options.anchorHardMaxBytes, readLimit + options.blockBytes);
        } else {
          preAnchorRecordIncompleteAtHardLimit = true;
          break;
        }
      }
    }
    summaries.push(...afterAnchorSummaries.filter((summary) => summary.turnId === targetTurnId));
    return { detail: null, stats, bytesRead, lineCount, boundaryFound, currentTurnId: targetTurnId, compaction, afterAnchorTurnIds: [...afterAnchorTurnIds], summaries, completedRecordBeyondInitial, preAnchorRecordIncompleteAtHardLimit };
  } finally {
    await handle.close();
  }
}

function recoveryEventKey(event) {
  return JSON.stringify([
    event.timestamp,
    event.turnId,
    event.itemId,
    event.callId,
    event.kind,
    event.role,
    event.phase,
    event.status,
    event.sourceThreadId,
  ]);
}

function mergeRecoverySummaries(...groups) {
  const merged = new Map();
  for (const event of groups.flat()) {
    if (event) merged.set(recoveryEventKey(event), event);
  }
  return [...merged.values()];
}

function oversizedToolOutputRecordFromEdges(prefix, suffix, targetTurnId) {
  const head = prefix.toString('utf8');
  const tail = suffix.toString('utf8');
  const recordType = /"type"\s*:\s*"([^"]+)"/u.exec(head)?.[1];
  const payloadType = /"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"/u.exec(head)?.[1];
  if (recordType !== 'response_item' || !payloadType?.endsWith('_call_output')) return null;
  const turnMetadata = `"internal_chat_message_metadata_passthrough":{"turn_id":"${targetTurnId}"`;
  if (!tail.includes(turnMetadata)) return null;
  const timestamp = /"timestamp"\s*:\s*"([^"]+)"/u.exec(head)?.[1];
  const itemId = /"payload"\s*:\s*\{[^}]*?"id"\s*:\s*"([^"]+)"/u.exec(head)?.[1];
  const callId = /"call_id"\s*:\s*"([^"]+)"/u.exec(head)?.[1];
  if (!timestamp || !itemId || !callId) return null;
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: payloadType,
      id: itemId,
      call_id: callId,
      output: [],
      internal_chat_message_metadata_passthrough: { turn_id: targetTurnId },
    },
  };
}

async function scanMatchingRecords(filePath, options, needleText, visitRecord, recoverOversizedRecord = null, prefixFilter = null) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const block = Buffer.allocUnsafe(options.blockBytes);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const needle = Buffer.from(needleText, 'utf8');
    let position = 0;
    let lineChunks = [];
    let lineBytes = 0;
    let prefix = Buffer.alloc(0);
    let suffix = Buffer.alloc(0);
    let searchTail = Buffer.alloc(0);
    let lineHasNeedle = false;
    let oversized = false;
    let discardCompaction = false;
    let lineCount = 0;
    let matchedRecordsParsed = 0;
    let skippedCompactionRecords = 0;
    let skippedMirrorRecords = 0;
    let summarizedOversizedRecords = 0;
    let done = false;

    const resetLine = () => {
      lineChunks = [];
      lineBytes = 0;
      prefix = Buffer.alloc(0);
      suffix = Buffer.alloc(0);
      searchTail = Buffer.alloc(0);
      lineHasNeedle = false;
      oversized = false;
      discardCompaction = false;
    };
    const appendPiece = (piece) => {
      if (piece.length === 0) return;
      lineBytes += piece.length;
      if (prefix.length < RECORD_PREFIX_BYTES) {
        const needed = RECORD_PREFIX_BYTES - prefix.length;
        prefix = Buffer.concat([prefix, piece.subarray(0, needed)]);
        const firstType = /"type"\s*:\s*"([^"]+)"/u.exec(prefix.toString('utf8'))?.[1];
        if (firstType === 'compacted') {
          discardCompaction = true;
          lineChunks = [];
        }
      }
      const searchable = searchTail.length > 0 ? Buffer.concat([searchTail, piece]) : piece;
      if (!lineHasNeedle && searchable.indexOf(needle) >= 0) lineHasNeedle = true;
      const tailLength = Math.min(Math.max(needle.length - 1, 0), searchable.length);
      searchTail = tailLength > 0 ? Buffer.from(searchable.subarray(searchable.length - tailLength)) : Buffer.alloc(0);
      const suffixSource = suffix.length > 0 ? Buffer.concat([suffix, piece]) : piece;
      suffix = Buffer.from(suffixSource.subarray(Math.max(0, suffixSource.length - RECORD_PREFIX_BYTES)));
      if (!discardCompaction && !oversized) {
        if (lineBytes > TARGETED_RECORD_MAX_BYTES) {
          oversized = true;
          lineChunks = [];
        } else lineChunks.push(Buffer.from(piece));
      }
    };
    const processLine = () => {
      lineCount += 1;
      if (discardCompaction) {
        skippedCompactionRecords += 1;
        resetLine();
        return;
      }
      if (!lineHasNeedle) {
        resetLine();
        return;
      }
      if (prefixFilter && !prefixFilter(prefix)) {
        resetLine();
        return;
      }
      const types = [...prefix.toString('utf8').matchAll(/"type"\s*:\s*"([^"]+)"/gu)].slice(0, 2).map((match) => match[1]);
      if (types[0] === 'event_msg' && types[1] === 'item_completed') {
        // item_completed duplicates the adjacent response_item and may embed
        // an entire command result. Recovery summaries do not consume it.
        skippedMirrorRecords += 1;
        resetLine();
        return;
      }
      if (oversized) {
        const recovered = recoverOversizedRecord?.(prefix, suffix, lineBytes) || null;
        if (recovered) {
          summarizedOversizedRecords += 1;
          resetLine();
          if (visitRecord(recovered, lineCount) === true) done = true;
          return;
        }
        throw new Error(`A record matching ${JSON.stringify(needleText)} exceeds the ${TARGETED_RECORD_MAX_BYTES}-byte targeted-record limit.`);
      }
      const bytes = lineChunks.length === 1 ? lineChunks[0] : Buffer.concat(lineChunks, lineBytes);
      const text = decoder.decode(bytes).replace(/\r$/u, '');
      resetLine();
      if (!text) return;
      let record;
      try { record = JSON.parse(text); }
      catch (error) { throw new Error(`Invalid rollout JSON encountered during exact-record lookup: ${error.message}`, { cause: error }); }
      matchedRecordsParsed += 1;
      if (visitRecord(record, lineCount) === true) done = true;
    };

    while (position < stats.size && !done) {
      const length = Math.min(block.length, stats.size - position);
      const result = await handle.read(block, 0, length, position);
      if (result.bytesRead !== length) throw new Error('Rollout file changed during exact-record lookup.');
      position += length;
      let start = 0;
      for (let index = 0; index < length; index += 1) {
        if (block[index] !== 0x0a) continue;
        appendPiece(block.subarray(start, index));
        processLine();
        start = index + 1;
        if (done) break;
      }
      if (!done && start < length) appendPiece(block.subarray(start, length));
    }
    if (!done && lineBytes > 0) processLine();
    return {
      direction: 'exact-id-stream-scan',
      fileBytes: stats.size,
      bytesScanned: position,
      matchedRecordsParsed,
      skippedCompactionRecords,
      skippedMirrorRecords,
      summarizedOversizedRecords,
      maxRetainedRecordBytes: TARGETED_RECORD_MAX_BYTES,
      complete: done || position >= stats.size,
    };
  } finally {
    await handle.close();
  }
}

async function readTargetTurnMetadata(filePath, options, targetTurnId) {
  const summaries = [];
  let boundaryFound = false;
  const needle = `"turn_id":"${targetTurnId}"`;
  const scan = await scanMatchingRecords(filePath, options, needle, (record, lineCount) => {
    const timestampMs = eventTime(record);
    if (timestampMs === null || turnIdOf(record) !== targetTurnId) return false;
    if (timestampMs > options.upperBound.getTime()) return true;
    const summary = summarizeResponseItem(record) || summarizeToolEvent(record) || summarizeTurnEvent(record);
    if (summary) {
      summary.reverseOrder = -lineCount;
      summaries.push(summary);
    }
    if (['task_started', 'turn_started'].includes(record?.payload?.type)) boundaryFound = true;
    return false;
  }, (prefix, suffix) => oversizedToolOutputRecordFromEdges(prefix, suffix, targetTurnId));
  return { used: true, ...scan, boundaryFound, summaries };
}

async function readRecoveryItem(filePath, options, itemId) {
  let detail = null;
  const needle = `"id":"${itemId}"`;
  const scan = await scanMatchingRecords(filePath, options, needle, (record) => {
    const timestampMs = eventTime(record);
    if (timestampMs === null) return false;
    if (timestampMs > options.upperBound.getTime()) return true;
    detail ||= detailFor(record, itemId);
    return Boolean(detail);
  });
  if (!detail) throw new Error(`Item ${itemId} was not found by exact-ID lookup before ${options.upperBound.toISOString()}.`);
  return { detail, scan };
}

function continuationPrefixKind(prefix) {
  const head = prefix.toString('utf8');
  const types = [...head.matchAll(/"type"\s*:\s*"([^"]+)"/gu)].slice(0, 2).map((match) => match[1]);
  if (types[0] === 'event_msg' && ['task_started', 'turn_started', 'task_complete', 'turn_complete', 'task_interrupted', 'turn_interrupted', 'turn_aborted'].includes(types[1])) return 'turn';
  if (types[0] === 'response_item' && types[1] === 'message' && /"role"\s*:\s*"user"/u.test(head)) return 'input';
  if (types[0] === 'response_item' && types[1] === 'function_call_output' && /<codex_delegation>/u.test(head)) return 'input';
  return null;
}

async function readContinuationAuthorization(segments, options, result) {
  let start = result.summaries.filter((e) => e.turnId === result.currentTurnId && e.kind === 'turn-status' && e.status === 'running')
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0];
  const links = [], scans = [], seen = new Set([result.currentTurnId]);
  const blocked = (reason, evidence = {}) => ({ authorization: null, source: { kind: 'prior-failed-turn', links, blockedReason: reason, ...evidence }, scans });
  while (start) {
    const startMs = Date.parse(start.timestamp);
    let predecessor = null, interveningInput = null;
    for (const segment of segments.filter((s) => s.timestampMs <= startMs)) {
      let boundary = null;
      const scan = await scanMatchingRecords(segment.filePath, options, '"type":', (record) => {
        const ms = eventTime(record);
        if (ms === null) throw new Error('Invalid timestamp in native continuation metadata.');
        if (ms >= startMs) return true;
        const event = summarizeTurnEvent(record);
        if (event?.turnId && event.turnId !== start.turnId && (!boundary || ms >= Date.parse(boundary.timestamp))) {
          boundary = event;
          if (interveningInput && Date.parse(interveningInput.timestamp) <= ms) interveningInput = null;
        } else {
          const input = summarizeResponseItem(record);
          if (['user-input', 'delegated-input'].includes(input?.kind)
            && (!interveningInput || ms >= Date.parse(interveningInput.timestamp))) interveningInput = { ...input, rolloutPath: segment.filePath };
        }
        return false;
      }, null, (prefix) => {
        const kind = continuationPrefixKind(prefix);
        if (kind === 'turn') return true;
        if (kind !== 'input' || (boundary && boundary.status !== 'failed')) return false;
        const timestamp = /"timestamp"\s*:\s*"([^"]+)"/u.exec(prefix.toString('utf8'))?.[1];
        return !Number.isFinite(Date.parse(timestamp)) || (!boundary || Date.parse(timestamp) > Date.parse(boundary.timestamp));
      });
      scans.push({ rolloutPath: segment.filePath, purpose: 'predecessor-boundary', ...scan });
      if (boundary) { predecessor = { boundary, rolloutPath: segment.filePath }; break; }
    }
    if (!predecessor) return blocked('preceding-native-turn-unavailable');
    const { boundary } = predecessor;
    if (boundary.status !== 'failed' || boundary.error?.codex_error_info !== 'server_overloaded') return blocked('preceding-turn-not-capacity-failure', { precedingTurn: boundary });
    if (interveningInput && Date.parse(interveningInput.timestamp) > Date.parse(boundary.timestamp)) return blocked('intervening-real-input', { interveningInput });
    if (seen.has(boundary.turnId)) return blocked('continuation-turn-cycle');
    seen.add(boundary.turnId);
    links.push({ fromTurnId: boundary.turnId, toTurnId: start.turnId, termination: boundary, resumedAt: start.timestamp, rolloutPath: predecessor.rolloutPath });
    let authorization = null, authorizationPath = null, priorStart = null;
    for (const segment of segments.filter((s) => s.timestampMs <= Date.parse(boundary.timestamp))) {
      const scan = await scanMatchingRecords(segment.filePath, options, `"turn_id":"${boundary.turnId}"`, (record) => {
        if (turnIdOf(record) !== boundary.turnId) return false;
        const ms = eventTime(record);
        if (ms === null) throw new Error('Invalid timestamp in prior-turn authorization metadata.');
        if (ms > Date.parse(boundary.timestamp)) return true;
        const turn = summarizeTurnEvent(record);
        if (turn?.status === 'running' && (!priorStart || ms < Date.parse(priorStart.timestamp))) priorStart = turn;
        const input = summarizeResponseItem(record);
        if (['user-input', 'delegated-input'].includes(input?.kind) && (!authorization || ms >= Date.parse(authorization.timestamp))) {
          authorization = input; authorizationPath = segment.filePath;
        }
        return false;
      }, null, (prefix) => continuationPrefixKind(prefix) !== null);
      scans.push({ rolloutPath: segment.filePath, purpose: 'prior-turn-authorization', ...scan });
      if (priorStart) break;
    }
    if (authorization) return { authorization, source: { kind: 'prior-failed-turn', rolloutPath: authorizationPath, turnId: authorization.turnId, itemId: authorization.itemId, links }, scans };
    if (!priorStart || Date.parse(priorStart.timestamp) >= startMs) return blocked('preceding-turn-start-unavailable');
    start = priorStart;
  }
  return blocked('current-turn-start-unavailable');
}

function recoveryProjection(threadId, filePath, upperBound, result) {
  const allEvents = result.summaries
    .filter((event) => event.turnId === result.currentTurnId)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || right.reverseOrder - left.reverseOrder);
  let sawAuthorization = false;
  let sawModelActivity = false;
  for (let index = 0; index < allEvents.length; index += 1) {
    const event = allEvents[index];
    if (event.kind === 'delegated-input') {
      sawAuthorization = true;
      continue;
    }
    if (event.kind !== 'user-input') {
      if (['model-activity', 'agent-message', 'tool-call'].includes(event.kind)) sawModelActivity = true;
      continue;
    }
    if (!sawAuthorization || !sawModelActivity) {
      event.lifecycle = { position: sawAuthorization ? 'co-initial' : 'initial', persisted: true };
      sawAuthorization = true;
      continue;
    }
    event.kind = 'user-steer';
    const laterEvents = allEvents.slice(index + 1);
    const absorbed = laterEvents.some((candidate) => ['model-activity', 'agent-message', 'tool-call'].includes(candidate.kind));
    const terminal = laterEvents.findLast((candidate) => candidate.kind === 'turn-status');
    event.lifecycle = {
      position: 'mid-turn',
      persisted: true,
      absorption: absorbed ? 'confirmed-by-later-model-activity' : 'not-observed',
      turnState: terminal?.status || 'active-at-anchor',
      semanticHandling: 'unknown',
    };
  }
  for (const event of allEvents) delete event.reverseOrder;
  const authorizations = allEvents.filter((event) => ['user-input', 'user-steer', 'delegated-input'].includes(event.kind));
  const agentMessages = allEvents.filter((event) => event.kind === 'agent-message');
  const toolEvents = allEvents.filter((event) => ['tool-call', 'tool-output', 'tool-status'].includes(event.kind));
  const returnedCallIds = new Set(toolEvents.filter((event) => event.kind === 'tool-output' && event.callId).map((event) => event.callId));
  for (const event of toolEvents) {
    if (event.kind === 'tool-call' && event.callId && returnedCallIds.has(event.callId)) event.status = 'returned';
  }
  const latestAuthorization = authorizations.at(-1) || result.continuation?.authorization || null;
  const latestAgentCheckpoint = agentMessages.at(-1) || null;
  const latestTool = toolEvents.at(-1) || null;
  const events = allEvents.filter((event) => !['tool-call', 'tool-output', 'tool-status', 'model-activity'].includes(event.kind) || event === latestTool);
  const eventCounts = Object.fromEntries([...new Set(allEvents.map((event) => event.kind))].sort().map((kind) => [kind, allEvents.filter((event) => event.kind === kind).length]));
  const detailItemIds = [...new Set([
    latestAuthorization?.itemId,
    latestAgentCheckpoint?.itemId,
    ...authorizations.filter((event) => !latestAgentCheckpoint || Date.parse(event.timestamp) > Date.parse(latestAgentCheckpoint.timestamp)).map((event) => event.itemId),
  ].filter(Boolean))];
  const problems = [];
  const laterTurnIds = (result.afterAnchorTurnIds || []).filter((turnId) => turnId !== result.currentTurnId).sort();
  const completedAfterCompaction = Boolean(result.compaction && allEvents.some((event) => event.kind === 'turn-status' && event.status === 'completed' && Date.parse(event.timestamp) > Date.parse(result.compaction.timestamp)));
  const interruptedAfterCompaction = Boolean(result.compaction && allEvents.some((event) => event.kind === 'turn-status' && ['failed', 'interrupted'].includes(event.status) && Date.parse(event.timestamp) > Date.parse(result.compaction.timestamp)));
  const delayReasons = [];
  if (laterTurnIds.length > 0) delayReasons.push('later-turn-observed-after-compaction');
  if (completedAfterCompaction) delayReasons.push('target-turn-completed-after-compaction');
  if (interruptedAfterCompaction) delayReasons.push('target-turn-terminated-after-compaction');
  const hookTiming = result.compaction ? {
    anchorSelection: 'latest-compaction-at-or-before-hook-upper-bound',
    delayMs: upperBound.getTime() - Date.parse(result.compaction.timestamp),
    delayed: delayReasons.length > 0,
    reasons: delayReasons,
    laterTurnIds,
  } : null;
  if (!result.compaction) problems.push(result.preAnchorRecordIncompleteAtHardLimit ? 'pre-anchor-rollout-record-not-complete-within-hard-limit' : 'compaction-anchor-not-found-within-limit');
  if (!result.currentTurnId) problems.push('current-turn-id-unavailable');
  if (!result.boundaryFound && result.exactTurnLookup?.complete !== true) problems.push('current-turn-metadata-lookup-incomplete');
  if (!latestAuthorization) problems.push('current-turn-authorization-unavailable');
  if (hookTiming?.delayed) problems.push('compact-hook-delayed-beyond-target-turn');
  if (detailItemIds.length > MAX_DETAIL_ITEMS) problems.push('too-many-detail-items-required');
  if (allEvents.some((event) => !Number.isFinite(Date.parse(event.timestamp)))) problems.push('event-timestamp-invalid');
  return {
    schemaVersion: 1,
    threadId,
    rolloutPath: filePath,
    upperBound: upperBound.toISOString(),
    read: {
      direction: result.exactTurnLookup?.used ? 'tail-backward-anchor+exact-id-stream-scan' : 'tail-backward',
      fileBytes: result.stats.size,
      bytesRead: result.bytesRead,
      initialMaxBytes: options.maxBytes,
      hardMaxBytes: options.anchorHardMaxBytes,
      anchorHardMaxBytes: options.anchorHardMaxBytes,
      expandedBeyondInitial: result.bytesRead > options.maxBytes,
      completedRecordBeyondInitial: result.completedRecordBeyondInitial,
      linesParsed: result.lineCount,
      boundaryFound: result.boundaryFound,
      exactTurnLookup: result.exactTurnLookup || null,
    },
    currentTurnId: result.currentTurnId,
    compaction: result.compaction,
    hookTiming,
    eventCounts,
    events,
    latest: { authorization: latestAuthorization, agentCheckpoint: latestAgentCheckpoint, tool: latestTool },
    authorizationSource: result.continuation?.source || null,
    continuationLookup: result.continuation?.scans || null,
    detailItemIds: detailItemIds.slice(0, MAX_DETAIL_ITEMS),
    metadataComplete: problems.length === 0,
    safeToContinue: false,
    nextAction: problems.length === 0 ? 'read-detail-items-and-compare-semantics' : 'remain-read-only',
    problems,
  };
}

const options = parseArguments(process.argv.slice(2));
const segments = options.rolloutPath
  ? [{ filePath: options.rolloutPath, ...await assertRolloutThread(options.rolloutPath, options.threadId) }]
  : await findRolloutSegments(options.sessionsRoot, options.threadId, options.upperBound);
const rolloutPath = segments[0].filePath;
await assertRolloutThread(rolloutPath, options.threadId);
let output;
if (options.itemId) {
  const result = await readRecoveryItem(rolloutPath, options, options.itemId);
  output = {
    schemaVersion: 1,
    threadId: options.threadId,
    rolloutPath,
    upperBound: options.upperBound.toISOString(),
    read: result.scan,
    item: result.detail,
  };
} else {
  const result = await readRecoveryWindow(rolloutPath, options);
  if (result.compaction && result.currentTurnId && !result.boundaryFound) {
    const lookup = await readTargetTurnMetadata(rolloutPath, options, result.currentTurnId);
    result.exactTurnLookup = { ...lookup, summaries: undefined };
    result.boundaryFound = lookup.boundaryFound;
    result.summaries = mergeRecoverySummaries(lookup.summaries, result.summaries);
  }
  output = recoveryProjection(options.threadId, rolloutPath, options.upperBound, result);
  if (output.problems.length === 1 && output.problems[0] === 'current-turn-authorization-unavailable') {
    result.continuation = await readContinuationAuthorization(segments, options, result);
    output = recoveryProjection(options.threadId, rolloutPath, options.upperBound, result);
  }
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
