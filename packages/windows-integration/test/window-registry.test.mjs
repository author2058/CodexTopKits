import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowRegistry, middleEllipsis } from '../src/window-registry.mjs';

test('windows keep creation order and independent HWND identities across removals', () => {
  const registry = new WindowRegistry(123);
  for (const id of ['a', 'b', 'c']) registry.update(id, { applicable: true, title: id });
  registry.bind('a', { handle: 10, processId: 123 }); registry.bind('c', { handle: 30, processId: 123 });
  registry.remove('b'); registry.update('d', { applicable: true });
  assert.deepEqual(registry.rows().map(value => [value.targetId, value.handle]), [['a', 10], ['c', 30], ['d', null]]);
  assert.throws(() => registry.bind('a', { handle: 30, processId: 456 }), /不属于/);
  assert.equal(registry.windows.get('a').handle, 10);
  registry.bind('d', { handle: 30, processId: 123 }); assert.equal(registry.windows.get('c').handle, null);
});

test('truncation measures actual glyph widths, keeps a fixed limit, and trims from the middle', () => {
  const measure = value => Array.from(value).reduce((sum, char) => sum + (char === '🐭' ? 20 : 10), 0);
  assert.equal(middleEllipsis('short🐭', 190, measure), 'short🐭');
  const result = middleEllipsis('abcdefghijklmnopqrstuvwxyz🐭', 190, measure);
  assert.ok(result.startsWith('abc') && result.endsWith('xyz🐭') && result.includes('...')); assert.ok(measure(result) <= 190);
  assert.equal(middleEllipsis('x'.repeat(19), 190, measure), 'x'.repeat(19));
});
