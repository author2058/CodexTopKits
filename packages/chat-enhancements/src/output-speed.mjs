export const numericTokenField = (container, camelName, snakeName) => {
      const value = container?.[camelName] ?? container?.[snakeName];
      return Number.isFinite(value) ? Number(value) : null;
    };

export const lastOutputTokenCount = (tokenUsage) => {
      const last = tokenUsage?.last || tokenUsage?.lastTokenUsage || tokenUsage?.last_token_usage;
      return numericTokenField(last, 'outputTokens', 'output_tokens');
    };

export const calculateOutputSpeed = (outputTokens, requestStartedAt, firstContentAt, lastContentAt) => {
      const tokensValid = Number.isSafeInteger(outputTokens) && outputTokens >= 0;
      const contentWindowValid = [firstContentAt, lastContentAt].every(Number.isFinite)
        && firstContentAt <= lastContentAt;
      const generationMs = contentWindowValid ? lastContentAt - firstContentAt : 0;
      const requestWindowValid = [requestStartedAt, firstContentAt].every(Number.isFinite) && requestStartedAt <= firstContentAt;
      const endToEndMs = contentWindowValid && requestWindowValid ? lastContentAt - requestStartedAt : 0;
      return {
        generationRate: tokensValid && outputTokens > 1 && generationMs > 1 ? (outputTokens - 1) / (generationMs / 1000) : null,
        endToEndRate: tokensValid && endToEndMs > 1 ? outputTokens / (endToEndMs / 1000) : null,
        ttftMs: requestWindowValid ? firstContentAt - requestStartedAt : null,
      };
    };

export const applyOutputSpeedMeasurement = (record, segment) => {
      if (!segment?.usageAssigned) return false;
      const metrics = segment.invalidPair ? { generationRate: null, endToEndRate: null, ttftMs: null }
        : calculateOutputSpeed(segment.outputTokens, segment.requestStartedAt, segment.firstContentAt, segment.lastContentAt);
      const firstItem = segment.firstContentItem;
      // A collapsed initial item cannot time the tokens counted before later output.
      if (firstItem && Number.isFinite(firstItem.completedAt) && firstItem.completedAt - firstItem.startedAt <= 1) metrics.generationRate = null;
      record.generationRate = metrics.generationRate;
      record.endToEndRate = metrics.endToEndRate;
      record.ttftMs = metrics.ttftMs;
      record.outputTokens = !segment.invalidPair && Number.isSafeInteger(segment.outputTokens) && segment.outputTokens >= 0 ? segment.outputTokens : null;
      record.measurementTurnId = record.turnId;
      record.measurementPending = false;
      return true;
    };

export function createOutputSpeedTracker(changed = () => {}, existing = null) {
    const state = { outputSpeedRecords: new Map(), outputCompletedTurns: new Set(), outputSpeedPairingVersion: 2 };
    const renderOutputTokenSpeed = changed;
    const cleanText = value => typeof value === 'string' ? value.trim() || null : null;
    const bareThreadId = value => typeof value === 'string' ? value.split(':').at(-1) : null;
    const currentOutputSpeedRecord = (threadId) => {
      if (!threadId) return null;
      let latest = null;
      for (const record of state.outputSpeedRecords.values()) {
        if (record.threadId === threadId && (!latest || record.updatedAt > latest.updatedAt)) latest = record;
      }
      return latest;
    };
    const previousOutputSpeedRecord = (threadId) => [...state.outputSpeedRecords.values()]
      .filter((entry) => entry.threadId === threadId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
    const ensureOutputSpeedRecord = (threadId, turnId, active = true, requestStartedAt = null) => {
      const key = threadId + ':' + turnId;
      let record = state.outputSpeedRecords.get(key);
      if (record) return record;
      const previous = previousOutputSpeedRecord(threadId);
      record = {
        threadId,
        turnId,
        active,
        generationRate: previous?.generationRate ?? null,
        endToEndRate: previous?.endToEndRate ?? null,
        ttftMs: previous?.ttftMs ?? null,
        outputTokens: previous?.outputTokens ?? null,
        measurementTurnId: previous?.measurementTurnId ?? previous?.turnId ?? null,
        measurementPending: active,
        updatedAt: performance.now(),
        responseSegments: [],
        lastUsageTotalOutput: previous?.lastUsageTotalOutput ?? null,
        pendingRequestStartedAt: Number.isFinite(requestStartedAt) ? requestStartedAt : null,
      };
      state.outputSpeedRecords.set(key, record);
      return record;
    };
    const outputEventTime = (params, started) => {
      const value = started ? params?.startedAtMs : params?.completedAtMs;
      return Number.isFinite(value) ? Number(value) : Date.now();
    };
    const modelContentItemTypes = new Set(['reasoning', 'agentMessage', 'plan', 'transcript']);
    const toolBoundaryItemTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity']);

    const currentResponseSegment = (record, at) => {
      let segment = record.responseSegments.findLast((entry) => entry.acceptingContent);
      if (segment) return segment;
      segment = {
        requestStartedAt: Number.isFinite(record.pendingRequestStartedAt) ? record.pendingRequestStartedAt : null,
        firstContentAt: null,
        lastContentAt: null,
        firstContentItem: null,
        acceptingContent: true,
        usageAssigned: false,
        outputTokens: null,
        toolBoundaryAt: null,
        closedBy: null,
      };
      record.pendingRequestStartedAt = null;
      record.measurementPending = true;
      record.responseSegments.push(segment);
      while (record.responseSegments.length > 16) record.responseSegments.shift();
      return segment;
    };
    const noteModelContent = (record, at) => {
      const segment = currentResponseSegment(record, at);
      if (!Number.isFinite(segment.firstContentAt)) segment.firstContentAt = at;
      segment.lastContentAt = Math.max(segment.lastContentAt ?? at, at);
      if (segment.usageAssigned) applyOutputSpeedMeasurement(record, segment);
      return segment;
    };
    const noteOutputItem = (params, started) => {
      const threadId = bareThreadId(params?.threadId);
      const turnId = cleanText(params?.turnId || params?.turn?.id);
      const item = params?.item;
      if (!threadId || !turnId || !item) return false;
      const record = ensureOutputSpeedRecord(threadId, turnId, true);
      const at = outputEventTime(params, started);
      if (modelContentItemTypes.has(item.type)) {
        if (!started && !record.responseSegments.some((entry) => entry.acceptingContent)) return false;
        const segment = currentResponseSegment(record, at);
        if (started && segment.firstContentAt === null && cleanText(item.id)) segment.firstContentItem = { id: item.id, startedAt: at, completedAt: null };
        else if (!started && segment.firstContentItem && segment.firstContentItem.id === item.id) segment.firstContentItem.completedAt = at;
        noteModelContent(record, at);
      } else if (toolBoundaryItemTypes.has(item.type)) {
        if (started) {
          // Several native tool items can be produced by one model response
          // (including commands nested inside a single exec tool). They are
          // not independent responses and must not create pending usage slots.
          const segment = record.responseSegments.findLast((entry) => entry.acceptingContent);
          if (segment && !Number.isFinite(segment.toolBoundaryAt)) {
            segment.toolBoundaryAt = at;
            segment.lastContentAt = Math.max(segment.lastContentAt ?? at, at);
          }
        } else {
          record.pendingRequestStartedAt = at;
          record.measurementPending = true;
        }
      } else {
        return false;
      }
      record.active = true;
      record.updatedAt = performance.now();
      renderOutputTokenSpeed();
      return true;
    };
    const noteOutputContentDelta = (params) => {
      const threadId = bareThreadId(params?.threadId);
      const turnId = cleanText(params?.turnId || params?.turn?.id);
      if (!threadId || !turnId) return false;
      const record = ensureOutputSpeedRecord(threadId, turnId, true);
      noteModelContent(record, Date.now());
      record.active = true;
      record.updatedAt = performance.now();
      renderOutputTokenSpeed();
      return true;
    };
    const noteOutputTokenUsage = (params) => {
      const threadId = bareThreadId(params?.threadId);
      const turnId = cleanText(params?.turnId || params?.turn?.id);
      const outputTokens = lastOutputTokenCount(params?.tokenUsage);
      if (!threadId || !turnId) return false;
      const now = performance.now();
      const key = threadId + ':' + turnId;
      const record = ensureOutputSpeedRecord(threadId, turnId, !state.outputCompletedTurns.has(key));
      record.active = !state.outputCompletedTurns.has(key);
      record.updatedAt = now;
      const usage = params.tokenUsage;
      const total = usage?.total || usage?.totalTokenUsage || usage?.total_token_usage;
      const cumulativeOutput = numericTokenField(total, 'outputTokens', 'output_tokens');
      if (Number.isFinite(cumulativeOutput) && record.lastUsageTotalOutput === cumulativeOutput) return false;
      const previousTotal = record.lastUsageTotalOutput;
      record.lastUsageTotalOutput = cumulativeOutput;
      // A native usage notification closes the current model response. Never
      // assign its tokens to an older unpaired tool-shaped segment.
      const segment = record.responseSegments.findLast((entry) => entry.acceptingContent) || currentResponseSegment(record, Date.now());
      segment.acceptingContent = false;
      segment.closedBy = 'tokenUsage';
      segment.usageAssigned = true;
      segment.outputTokens = outputTokens;
      segment.usageTotalOutput = cumulativeOutput;
      if (Number.isFinite(previousTotal) && Number.isFinite(cumulativeOutput) && cumulativeOutput - previousTotal !== outputTokens) {
        segment.closedBy = 'tokenUsage:unmatched-total';
        segment.invalidPair = true;
        applyOutputSpeedMeasurement(record, segment);
        renderOutputTokenSpeed();
        return false;
      }
      applyOutputSpeedMeasurement(record, segment);
      renderOutputTokenSpeed();
      return true;
    };
    const setOutputTurnActive = (params, active) => {
      const threadId = bareThreadId(params?.threadId);
      const turnId = cleanText(params?.turnId || params?.turn?.id);
      if (!threadId || !turnId) return false;
      const key = threadId + ':' + turnId;
      if (active) {
        const now = performance.now();
        const startedAt = outputEventTime(params, true);
        state.outputCompletedTurns.delete(key);
        const record = ensureOutputSpeedRecord(threadId, turnId, true, startedAt);
        record.active = true;
        record.measurementPending = true;
        if (!Number.isFinite(record.pendingRequestStartedAt) && record.responseSegments.length === 0) record.pendingRequestStartedAt = startedAt;
        record.updatedAt = now;
      } else {
        const record = state.outputSpeedRecords.get(key);
        if (record) {
          const segment = record.responseSegments.findLast((entry) => entry.acceptingContent);
          if (segment) segment.acceptingContent = false;
          record.active = false;
          record.updatedAt = performance.now();
        }
        state.outputCompletedTurns.add(key);
        if (state.outputCompletedTurns.size > 100) state.outputCompletedTurns.delete(state.outputCompletedTurns.values().next().value);
      }
      renderOutputTokenSpeed();
      return true;
    };

    // Rebuild retained measurements from observed segments; do not carry old mixed fields across reinjection.
    state.outputCompletedTurns = new Set(existing?.outputCompletedTurns || []);
    for (const previous of existing?.outputSpeedRecords?.values() || []) {
      const record = ensureOutputSpeedRecord(previous.threadId, previous.turnId, previous.active, previous.pendingRequestStartedAt);
      record.responseSegments = previous.responseSegments || [];
      record.pendingRequestStartedAt = previous.pendingRequestStartedAt;
      record.updatedAt = previous.updatedAt;
      if (existing.outputSpeedPairingVersion !== 2) {
        // Legacy tool-based segments cannot be paired reliably after the fact.
        // Retain the displayed group as pending until a fresh native pair arrives.
        for (const field of ['generationRate', 'endToEndRate', 'ttftMs', 'outputTokens', 'measurementTurnId']) record[field] = previous[field] ?? null;
        record.responseSegments = [];
        record.pendingRequestStartedAt = null;
        record.measurementPending = true;
        continue;
      }
      record.lastUsageTotalOutput = previous.lastUsageTotalOutput ?? null;
      for (const segment of record.responseSegments) {
        if (segment.closedBy === 'tokenUsage:unmatched-total') { segment.usageAssigned = true; segment.invalidPair = true; }
        record.measurementPending = true;
        applyOutputSpeedMeasurement(record, segment);
      }
      if (previous.measurementPending || Number.isFinite(record.pendingRequestStartedAt)) record.measurementPending = true;
    }

    return {
      read: currentOutputSpeedRecord, snapshot: () => state,
      noteOutputItem, noteOutputTokenUsage, setOutputTurnActive,
      receive(method, params) {
        if (method === 'turn/started') return setOutputTurnActive(params, true);
        if (method === 'turn/completed') return setOutputTurnActive(params, false);
        if (method === 'item/started' || method === 'item/completed') return noteOutputItem(params, method === 'item/started');
        if (method === 'thread/tokenUsage/updated') return noteOutputTokenUsage(params);
        if (['item/agentMessage/delta','item/plan/delta','item/transcript/delta','item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded'].includes(method)) return noteOutputContentDelta(params);
        return false;
      },
    };
}
