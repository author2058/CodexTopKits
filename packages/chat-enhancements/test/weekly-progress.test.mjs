import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklyProgress } from '../src/weekly-progress.mjs';

const day = 86400000;
const resetAt = Date.parse('2026-10-10T04:23:00Z');
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00000001, actual + ' != ' + expected);

test('user example: five intervals, time at 1.5 days and quota at 0.8 days', () => {
  const value = weeklyProgress({ remainingPercent: 60, resetAt }, resetAt - 3.5 * day);
  assert.equal(value.days, 5);
  close(value.timePercent, 30);
  close(value.usagePercent, 16);
  assert.equal(value.startAt, resetAt - 5 * day);
});

test('day boundary shrinks both scales only when quota also fits', () => {
  const weekly = { remainingPercent: 40, resetAt };
  assert.equal(weeklyProgress(weekly, resetAt - 3 * day - 1).days, 4);
  const value = weeklyProgress(weekly, resetAt - 3 * day);
  assert.equal(value.days, 3);
  assert.equal(value.timePercent, 0);
  close(value.usagePercent, 100 / 15);
  assert.equal(weeklyProgress({ ...weekly, remainingPercent: 60 }, resetAt - 3 * day).days, 5);
});

test('usage update changes common scale; expired zero window has no fabricated denominator', () => {
  const now = resetAt - 1.5 * day;
  assert.equal(weeklyProgress({ remainingPercent: 100, resetAt }, now).days, 7);
  assert.equal(weeklyProgress({ remainingPercent: 20, resetAt }, now).days, 2);
  const zeroQuota = weeklyProgress({ remainingPercent: 0, resetAt }, now);
  assert.equal(zeroQuota.days, 2);
  assert.equal(zeroQuota.usagePercent, 100);
  assert.equal(weeklyProgress({ remainingPercent: 0, resetAt }, resetAt), null);
  assert.equal(weeklyProgress(null, now), null);
});

test('GMT+8 06:00 marker lies in the time endpoint cell, anchored to reset time', () => {
  const value = weeklyProgress({ remainingPercent: 60, resetAt }, resetAt - 3.5 * day);
  const fraction = (17 * 60 + 37) / (24 * 60); // 12:23 -> next day 06:00 GMT+8
  close(value.timeMorningPercent, (1 + fraction) / 5 * 100);
  const at = value.startAt + value.timeMorningPercent / 100 * value.days * day;
  assert.equal(new Date(at + 8 * 3600000).toISOString().slice(11, 19), '06:00:00');
});

test('marker follows date cells and scale changes, not quota endpoint movement', () => {
  const weekly = { remainingPercent: 40, resetAt };
  const four = weeklyProgress(weekly, resetAt - 3 * day - 1);
  const three = weeklyProgress(weekly, resetAt - 3 * day);
  const fraction = (17 * 60 + 37) / (24 * 60);
  close(four.timeMorningPercent, fraction / 4 * 100);
  close(three.timeMorningPercent, fraction / 3 * 100);
  const empty = weeklyProgress({ remainingPercent: 0, resetAt }, resetAt - 3 * day);
  close(empty.timeMorningPercent, three.timeMorningPercent);
  const nextCell = weeklyProgress(weekly, resetAt - 2 * day);
  close(nextCell.timeMorningPercent, (1 + fraction) / 3 * 100);
  close(weeklyProgress(weekly, resetAt).timeMorningPercent, (2 + fraction) / 3 * 100);
});

test('reset exactly at GMT+8 06:00 puts the marker on the cell start', () => {
  const reset = Date.parse('2026-10-09T22:00:00Z');
  const value = weeklyProgress({ remainingPercent: 50, resetAt: reset }, reset - 5 * day);
  close(value.timeMorningPercent, 0);
});
