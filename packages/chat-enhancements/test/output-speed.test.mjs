import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { chatCss, speedHistoryCss } from '../src/styles.mjs';
import { numericTokenField, lastOutputTokenCount, calculateOutputSpeed, applyOutputSpeedMeasurement, createOutputSpeedTracker } from '../src/output-speed.mjs';
const retained = () => ({ turnId: 'new-turn', measurementTurnId: 'old-turn', generationRate: 50, endToEndRate: 25, ttftMs: 2000, outputTokens: 101, measurementPending: false });
const valid = () => ({ usageAssigned: true, outputTokens: 201, requestStartedAt: 1000, firstContentAt: 4000, lastContentAt: 8000 });

test('legacy CSS hands off speed without removing history button styling', () => {
  const combined = speedHistoryCss('.codex-output-token-speed,.codex-turn-history-all');
  assert.equal(chatCss(false, ['output-speed']), chatCss().replace(combined, speedHistoryCss('.codex-turn-history-all')));
});

test('speed tag has light fallbacks while retaining dark colors', () => {
  const css = speedHistoryCss('.codex-output-token-speed');
  assert.match(css, /light-dark\(#ffffff,#10131b\)/);
  assert.match(css, /light-dark\(#4b5563,#aab4c4\)/);
});

test('complete measurements update all rates, token count and provenance together', () => {
  const record = retained();
  assert.equal(applyOutputSpeedMeasurement(record, valid()), true);
  assert.equal(record.generationRate, 50);
  assert.equal(record.endToEndRate, 201 / 7);
  assert.equal(record.ttftMs, 3000);
  assert.equal(record.outputTokens, 201);
  assert.equal(record.measurementTurnId, 'new-turn');
  assert.equal(record.measurementPending, false);
});

test('zero-duration generation is cleared while the same response supplies end-to-end and TTFT', () => {
  const record = retained();
  const sample = { ...valid(), outputTokens: 573, requestStartedAt: 2543, firstContentAt: 4000, lastContentAt: 4000 };
  assert.equal(calculateOutputSpeed(573, 2543, 4000, 4000).endToEndRate, 573 / 1.457);
  assert.equal(applyOutputSpeedMeasurement(record, sample), true);
  assert.deepEqual(record, { ...retained(), generationRate: null, endToEndRate: 573 / 1.457,
    ttftMs: 1457, outputTokens: 573, measurementTurnId: 'new-turn' });
});

test('missing request timing clears only end-to-end and TTFT instead of keeping older values', () => {
  const record = retained();
  assert.equal(applyOutputSpeedMeasurement(record, { ...valid(), requestStartedAt: null }), true);
  assert.deepEqual(record, { ...retained(), generationRate: 50, endToEndRate: null, ttftMs: null,
    outputTokens: 201, measurementTurnId: 'new-turn' });
  assert.equal(applyOutputSpeedMeasurement(record, valid()), true);
  assert.equal(record.measurementPending, false);
  assert.equal(record.measurementTurnId, 'new-turn');
});

test('a first completed sample publishes null only for the invalid metric', () => {
  const record = { turnId: 'new-turn', generationRate: null, endToEndRate: null, ttftMs: null, outputTokens: null, measurementTurnId: null, measurementPending: true };
  assert.equal(applyOutputSpeedMeasurement(record, { ...valid(), firstContentAt: 8000 }), true);
  assert.equal(record.generationRate, null);
  assert.equal(record.endToEndRate, 201 / 7);
  assert.equal(record.ttftMs, 7000);
  assert.equal(record.measurementTurnId, 'new-turn');
  assert.equal(record.measurementPending, false);
});

test('one-millisecond rate intervals are invalid without imposing a speed ceiling', () => {
  const short = calculateOutputSpeed(201, 1000, 3000, 3001);
  assert.equal(short.generationRate, null);
  assert.equal(short.endToEndRate, 201 / 2.001);
  assert.equal(short.ttftMs, 2000);
  assert.deepEqual(calculateOutputSpeed(201, 3000, 3000, 3001), { generationRate: null, endToEndRate: null, ttftMs: 0 });
  assert.equal(calculateOutputSpeed(201, 1000, 3000, 3002).generationRate, 100000);
});

test('invalid token counts clear rates but do not replace a valid same-request TTFT', () => {
  for (const tokens of [null, NaN, -1, 3.5, Number.MAX_SAFE_INTEGER + 1]) {
    const record = retained();
    assert.equal(applyOutputSpeedMeasurement(record, { ...valid(), outputTokens: tokens }), true);
    assert.equal(record.generationRate, null); assert.equal(record.endToEndRate, null);
    assert.equal(record.ttftMs, 3000); assert.equal(record.outputTokens, null);
    assert.equal(record.measurementTurnId, 'new-turn');
  }
});

test('observed collapsed intervals no longer keep an older generation value beside new metrics', () => {
  const examples = [
    { first: { usageAssigned: true, outputTokens: 1417, requestStartedAt: 1791832033113, firstContentAt: 1791832036269, lastContentAt: 1791832061939 }, next: { usageAssigned: true, outputTokens: 573, requestStartedAt: 1791832061940, firstContentAt: 1791832063397, lastContentAt: 1791832063397 } },
    { first: { usageAssigned: true, outputTokens: 122, requestStartedAt: 1791832879232, firstContentAt: 1791832884563, lastContentAt: 1791832901658 }, next: { usageAssigned: true, outputTokens: 625, requestStartedAt: 1791832902662, firstContentAt: 1791832907120, lastContentAt: 1791832907120 } },
  ];
  for (const { first, next } of examples) {
    const record = retained();
    assert.equal(applyOutputSpeedMeasurement(record, first), true);
    assert.equal(applyOutputSpeedMeasurement(record, next), true);
    assert.equal(record.generationRate, null);
    assert.equal(record.endToEndRate, next.outputTokens * 1000 / (next.lastContentAt - next.requestStartedAt));
    assert.equal(record.ttftMs, next.firstContentAt - next.requestStartedAt);
    assert.equal(record.outputTokens, next.outputTokens);
    assert.equal(record.measurementPending, false);
  }
});

test('reinjection repairs mixed groups and preserves inherited results and completed-turn identity', () => {
  const complete = { usageAssigned: true, outputTokens: 1417, requestStartedAt: 1791832033113, firstContentAt: 1791832036269, lastContentAt: 1791832061939 };
  const incomplete = { usageAssigned: true, outputTokens: 573, requestStartedAt: 1791832061940, firstContentAt: 1791832063397, lastContentAt: 1791832063397 };
  const mixed = { threadId: 't', turnId: 'completed', active: false, generationRate: 55.161667315932995, endToEndRate: 393.273850377488, ttftMs: 1457, outputTokens: 573, measurementTurnId: 'completed', measurementPending: true, updatedAt: 1, responseSegments: [complete, incomplete], pendingRequestStartedAt: null };
  const waiting = { ...mixed, turnId: 'waiting', active: true, updatedAt: 2, responseSegments: [], pendingRequestStartedAt: 1791832070000 };
  const existing = { outputSpeedPairingVersion: 2, outputSpeedRecords: new Map([['t:completed', mixed], ['t:waiting', waiting]]), outputCompletedTurns: new Set(['t:completed']) };
  const state = createOutputSpeedTracker(() => {}, existing).snapshot();
  const expected = calculateOutputSpeed(573, incomplete.requestStartedAt, incomplete.firstContentAt, incomplete.lastContentAt);
  for (const record of state.outputSpeedRecords.values()) {
    assert.equal(record.generationRate, expected.generationRate);
    assert.equal(record.endToEndRate, expected.endToEndRate);
    assert.equal(record.ttftMs, expected.ttftMs);
    assert.equal(record.outputTokens, 573);
    assert.equal(record.measurementTurnId, 'completed');
    assert.equal(record.measurementPending, true);
  }
  assert.equal(state.outputCompletedTurns.has('t:completed'), true);
});

function eventFixture() {
  const api = vm.runInNewContext('(' + createOutputSpeedTracker.toString() + ')()', {
    numericTokenField, lastOutputTokenCount, calculateOutputSpeed, applyOutputSpeedMeasurement,
    performance: { now: () => 5000 }, Date: { now: () => 5000 },
  });
  api.setOutputTurnActive({ threadId: 't', turnId: 'turn', startedAtMs: 1000 }, true);
  return {
    api,
    record: () => api.snapshot().outputSpeedRecords.get('t:turn'),
    item: (type, id, at, started = true) => api.noteOutputItem({ threadId: 't', turnId: 'turn', item: { type, id }, [started ? 'startedAtMs' : 'completedAtMs']: at }, started),
    usage: (tokens, total) => api.noteOutputTokenUsage({ threadId: 't', turnId: 'turn', tokenUsage: { last: { outputTokens: tokens }, total: { outputTokens: total } } }),
  };
}

test('observed one-millisecond first reasoning items invalidate generation even with a later tool boundary', () => {
  const samples = [
    { tokens: 253, request: 1794915497111, first: 1794915502576, end: 1794915502577, tool: 1794915503569 },
    { tokens: 294, request: 1794915506354, first: 1794915511654, end: 1794915511655, tool: 1794915512815 },
  ];
  for (const sample of samples) {
    const f = eventFixture();
    f.item('commandExecution', 'prior', sample.request, false);
    f.item('reasoning', 'first', sample.first); f.item('reasoning', 'first', sample.end, false);
    f.item('commandExecution', 'next', sample.tool); f.usage(sample.tokens, sample.tokens);
    const record = f.record();
    assert.equal(record.generationRate, null);
    assert.equal(record.endToEndRate, sample.tokens / ((sample.tool - sample.request) / 1000));
    assert.equal(record.ttftMs, sample.first - sample.request);
    assert.equal(record.outputTokens, sample.tokens);
    assert.equal(record.measurementPending, false);
    const restored = createOutputSpeedTracker(() => {}, f.api.snapshot()).read('t');
    assert.equal(restored.generationRate, null); assert.equal(restored.endToEndRate, record.endToEndRate);
  }
});

test('a complete usage notification with no observed content clears all old values', () => {
  const f = eventFixture();
  f.item('agentMessage', 'first', 2000); f.item('agentMessage', 'first', 4000, false); f.usage(101, 101);
  f.usage(201, 302);
  const record = f.record();
  assert.equal(record.generationRate, null); assert.equal(record.endToEndRate, null); assert.equal(record.ttftMs, null);
  assert.equal(record.measurementPending, false); assert.equal(record.outputTokens, 201);
});

test('Terra subagent message arguments extend the response boundary beyond the short reasoning item', () => {
  const samples = [
    { tokens: 302, request: 1793607519274, first: 1793607521219, reasoningEnd: 1793607521360, toolStart: 1793607524881, toolEnd: 1793607525960 },
    { tokens: 138, request: 1793608274367, first: 1793608278609, reasoningEnd: 1793608278717, toolStart: 1793608280186, toolEnd: 1793608281474 },
  ];
  for (const sample of samples) {
    const f = eventFixture();
    f.item('commandExecution', 'prior-tool', sample.request, false);
    f.item('reasoning', 'reason', sample.first);
    f.item('reasoning', 'reason', sample.reasoningEnd, false);
    f.item('subAgentActivity', 'send-message', sample.toolStart);
    f.item('subAgentActivity', 'send-message', sample.toolEnd, false);
    f.usage(sample.tokens, sample.tokens);
    const record = f.record(), segment = record.responseSegments[0];
    assert.equal(segment.toolBoundaryAt, sample.toolStart);
    assert.equal(segment.lastContentAt, sample.toolStart);
    assert.equal(record.generationRate, (sample.tokens - 1) * 1000 / (sample.toolStart - sample.first));
    assert.equal(record.endToEndRate, sample.tokens * 1000 / (sample.toolStart - sample.request));
    assert.equal(record.pendingRequestStartedAt, sample.toolEnd);
    assert.equal(record.responseSegments.length, 1);
    // Tool execution is not model generation; its completion starts the next request.
    f.item('reasoning', 'next-reason', sample.toolEnd + 1000);
    f.item('agentMessage', 'next-message', sample.toolEnd + 3000, false);
    f.usage(101, sample.tokens + 101);
    assert.equal(record.responseSegments.length, 2);
    assert.equal(record.generationRate, 50);
    assert.equal(record.endToEndRate, 101 / 3);
  }
});

test('one response with multiple native tool items receives exactly one usage pair; next response does not drift', () => {
  const f = eventFixture();
  f.item('reasoning', 'r1', 2000); f.item('reasoning', 'r1', 3000, false);
  f.item('commandExecution', 'c1', 4000); f.item('commandExecution', 'c2', 6000); f.item('imageView', 'image1', 7000);
  f.item('commandExecution', 'c1', 8000, false);
  f.usage(101, 101);
  assert.equal(f.record().responseSegments.length, 1);
  assert.equal(f.record().responseSegments[0].lastContentAt, 4000);
  assert.equal(f.record().responseSegments[0].outputTokens, 101);
  f.item('commandExecution', 'c2', 9000, false);
  f.item('reasoning', 'r2', 10000); f.item('reasoning', 'r2', 13000, false); f.item('commandExecution', 'c3', 14000);
  f.usage(201, 302);
  assert.equal(f.record().responseSegments.length, 2);
  assert.equal(f.record().responseSegments[1].outputTokens, 201);
  assert.equal(f.record().generationRate, 50);
  assert.equal(f.record().endToEndRate, 201 / 5);
});

test('late tool and model completion events after usage cannot fabricate response slots', () => {
  const f = eventFixture(); f.item('agentMessage', 'a1', 2000); f.item('agentMessage', 'a1', 4000, false); f.usage(101, 101);
  f.item('fileChange', 'nested', 5000); f.item('imageView', 'nested-image', 6000); f.item('agentMessage', 'a1', 7000, false);
  assert.equal(f.record().responseSegments.length, 1);
  assert.equal(f.record().responseSegments[0].outputTokens, 101);
});

test('duplicate usage with unchanged cumulative total cannot consume the next response', () => {
  const f = eventFixture(); f.item('reasoning', 'r1', 2000); f.item('reasoning', 'r1', 4000, false); f.usage(101, 101);
  f.item('commandExecution', 'c1', 8000, false); f.item('agentMessage', 'a2', 10000); f.item('agentMessage', 'a2', 14000, false);
  assert.equal(f.usage(101, 101), false);
  assert.equal(f.record().responseSegments[1].acceptingContent, true);
  f.usage(201, 302); assert.equal(f.record().outputTokens, 201);
});

test('mismatched usage clears the entire ambiguous response and recovers on the next exact pair', () => {
  const f = eventFixture(); f.item('agentMessage', 'a1', 2000); f.item('agentMessage', 'a1', 4000, false); f.usage(101, 101);
  f.item('commandExecution', 'c1', 8000, false); f.item('agentMessage', 'a2', 10000); f.item('agentMessage', 'a2', 14000, false);
  assert.equal(f.usage(201, 503), false);
  assert.equal(f.record().generationRate, null); assert.equal(f.record().endToEndRate, null);
  assert.equal(f.record().ttftMs, null); assert.equal(f.record().measurementPending, false);
  f.item('commandExecution', 'c2', 16000, false); f.item('agentMessage', 'a3', 18000); f.item('agentMessage', 'a3', 22000, false);
  f.usage(201, 704); assert.equal(f.record().outputTokens, 201); assert.equal(f.record().measurementPending, false);
});

test('more than sixteen responses with nested tools keep tokens paired with the current response', () => {
  const f = eventFixture();
  for (let index = 0; index < 20; index++) {
    const at = 10000 * index + 2000;
    if (index) f.item('commandExecution', 'return' + index, at - 1000, false);
    f.item('reasoning', 'r' + index, at); f.item('agentMessage', 'a' + index, at + 1000);
    f.item('commandExecution', 'c' + index, at + 2000); f.item('commandExecution', 'nested' + index, at + 3000);
    f.usage(101, 101 * (index + 1));
  }
  assert.equal(f.record().responseSegments.length, 16);
  assert.equal(f.record().responseSegments.at(-1).usageTotalOutput, 2020);
  assert.equal(f.record().responseSegments.at(-1).outputTokens, 101);
  assert.equal(f.record().generationRate, 50);
});

test('reinjection drops legacy mispaired segments and keeps the displayed group pending for a fresh pair', () => {
  const old = { ...retained(), threadId: 't', active: false, responseSegments: [valid()], updatedAt: 1 };
  const existing = { outputSpeedRecords: new Map([['t:old', old]]) };
  const state = createOutputSpeedTracker(() => {}, existing).snapshot();
  const record = state.outputSpeedRecords.get('t:new-turn');
  assert.equal(record.responseSegments.length, 0); assert.equal(record.measurementPending, true);
  assert.equal(record.generationRate, old.generationRate); assert.equal(record.endToEndRate, old.endToEndRate);
});
