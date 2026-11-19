import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openThemeStore } from '../src/store.mjs';
import { ThemeConfigError } from '../src/model.mjs';

const initial = JSON.parse(await fs.readFile(new URL('../assets/theme-map.json', import.meta.url), 'utf8'));

test('one store serializes changes and preserves unknown existing settings and UTF-8 project names', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-theme-store-')), filename = path.join(directory, 'map.json');
  const errors = [], changes = [];
  const store = await openThemeStore({ filename, defaultMap: { ...initial, retainedSetting: '保留' }, changed: map => changes.push(map), failed: error => errors.push(error) });
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true }); });
  await Promise.all([store.assign({ kind: 'project', key: '工程甲', value: 'red' }), store.assign({ kind: 'task', key: 'local:one', value: 'inherit' })]);
  await store.assign({ kind: 'project', key: '__proto__', value: 'blue' });
  const bytes = await fs.readFile(filename), map = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.notEqual(bytes[0], 0xef);
  assert.equal(map.projects['工程甲'], 'red'); assert.equal(map.tasks['local:one'], 'inherit');
  assert.equal(map.projects.__proto__, 'blue'); assert.equal(map.retainedSetting, '保留');
  await assert.rejects(store.assign({ kind: 'project', key: '工程甲', value: 'missing' }), ThemeConfigError);
  assert.equal(store.map.projects['工程甲'], 'red'); assert.equal(errors.length, 0); assert.equal(changes.length, 3);
});

test('an external map change is event-driven and an invalid existing file is never overwritten', { timeout: 5000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-theme-watch-')), filename = path.join(directory, 'map.json');
  let changed;
  const observed = new Promise(resolve => { changed = resolve; });
  const errors = [];
  const store = await openThemeStore({ filename, defaultMap: initial, changed, failed: error => errors.push(error) });
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true }); });
  await fs.writeFile(filename, JSON.stringify({ ...initial, uiFontSizeOverride: 20 }), 'utf8');
  await observed; assert.equal(store.map.uiFontSizeOverride, 20);
  await store.close();
  await fs.writeFile(filename, 'INVALID JSON', 'utf8');
  await assert.rejects(openThemeStore({ filename, defaultMap: initial, changed() {}, failed() {} }), SyntaxError);
  assert.equal(await fs.readFile(filename, 'utf8'), 'INVALID JSON');
});
