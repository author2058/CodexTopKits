import test from 'node:test';
import assert from 'node:assert/strict';
import { readComposerContextUsage, composerHasCharacters, contextUsageBarStyle, updateContextCompactionState } from '../src/context-usage.mjs';
import { chatCss, contextUsageCss, contextUsageTicksCss } from '../src/styles.mjs';

test('exact threshold boundaries and percentage width', () => {
  for (const [percent, color] of [[0, '#22c55e'], [60, '#22c55e'], [60.01, '#eab308'], [75, '#eab308'], [75.01, '#f97316'], [83.33333, '#f97316'], [83.333331, '#ef4444'], [85, '#ef4444'], [100, '#ef4444']]) {
    assert.deepEqual(contextUsageBarStyle(percent), { percent, width: percent + '%', color, animation: color === '#ef4444' ? 'cdt-context-usage-pulse 2000ms ease-in-out infinite' : 'none' });
  }
  assert.equal(contextUsageBarStyle(null), null);
  assert.equal(contextUsageBarStyle(NaN), null);
  assert.equal(contextUsageBarStyle(-1).width, '0%');
  assert.equal(contextUsageBarStyle(101).width, '100%');
});

test('red alert is 4Hz with characters and 0.5Hz without, unless compacting', () => {
  assert.equal(contextUsageBarStyle(90, false, true).animation, 'cdt-context-usage-pulse 250ms ease-in-out infinite');
  assert.equal(contextUsageBarStyle(90, false, false).animation, 'cdt-context-usage-pulse 2000ms ease-in-out infinite');
  assert.equal(contextUsageBarStyle(90, true, true).animation, 'none');
  assert.equal(contextUsageBarStyle(90, true, false).animation, 'none');
  assert.equal(contextUsageBarStyle(80, false, true).animation, 'none');
  const text = (textContent) => ({ nodeType: 3, textContent });
  const element = (childNodes = [], prediction = false) => ({ nodeType: 1, childNodes, hasAttribute: (name) => prediction && name === 'data-cumberbatch' });
  const prediction = element([element([text('预测的下一条消息')])], true);
  for (const [editor, expected] of [[null, false], [element(), false], [element([text('a')]), true], [element([text(' ')]), true], [{ value: '', textContent: 'placeholder' }, false], [{ value: '文字' }, true], [element([element([prediction])]), false], [element([text('实际输入'), prediction]), true], [element([text('预测的下一条消息')]), true]]) {
    assert.equal(composerHasCharacters({ querySelector: () => editor }), expected);
  }
});

test('native compaction lifecycle turns only its own bar gray and stops flashing', () => {
  const active = new Map();
  const event = (threadId, turnId = 'turn1', itemId = 'compact1') => ({ threadId, turnId, item: { id: itemId, type: 'contextCompaction' } });
  assert.equal(updateContextCompactionState(active, 'item/started', event('local:a')), true);
  assert.equal(contextUsageBarStyle(90, active.has('a')).color, '#9ca3af');
  assert.equal(contextUsageBarStyle(90, active.has('a')).animation, 'none');
  assert.equal(contextUsageBarStyle(90, active.has('b')).color, '#ef4444');
  assert.notEqual(contextUsageBarStyle(90, active.has('b')).animation, 'none');
  assert.equal(updateContextCompactionState(active, 'thread/tokenUsage/updated', { threadId: 'a' }), false);
  assert.equal(updateContextCompactionState(active, 'item/completed', event('a', 'old-turn')), false);
  assert.equal(updateContextCompactionState(active, 'item/completed', event('a', 'turn1', 'old-item')), false);
  assert.equal(updateContextCompactionState(active, 'item/completed', event('a')), true);
  assert.equal(contextUsageBarStyle(40, active.has('a')).color, '#22c55e');
  updateContextCompactionState(active, 'item/started', event('a'));
  assert.equal(updateContextCompactionState(active, 'turn/completed', { threadId: 'a', turn: { id: 'turn1', status: 'failed' } }), true);
  assert.equal(active.size, 0);
});

test('native ring precision is preserved; absent or invalid data is not fabricated as zero', () => {
  const composer = (offset) => ({ querySelector: () => offset === undefined ? null : { getAttribute: () => offset } });
  assert.ok(Math.abs(readComposerContextUsage(composer('60.4609133126935')) - 39.5390866873065) < 0.00000001);
  assert.equal(readComposerContextUsage(composer('100')), 0);
  assert.equal(readComposerContextUsage(composer('0')), 100);
  for (const offset of [undefined, null, '', 'bad']) assert.equal(readComposerContextUsage(composer(offset)), null);
});

test('legacy CSS hands off only the context meter styles', () => {
  assert.equal(chatCss(false, ['context-meter']), chatCss().replace(contextUsageCss(), '').replace(contextUsageTicksCss(), ''));
});
