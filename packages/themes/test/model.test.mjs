import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { validateMap, canonicalTaskKey, projectNameForThread, resolveTheme, ThemeConfigError } from '../src/model.mjs';
import { themeCss, themeChannelColor } from '../src/styles.mjs';

const initial = JSON.parse(await fs.readFile(new URL('../assets/theme-map.json', import.meta.url), 'utf8'));

test('theme channels preserve accent and use it for the light surface only', () => {
  assert.equal(themeChannelColor('accent', '#ef5c70', '#ef5c70'), '#ef5c70');
  assert.equal(themeChannelColor('surface', '#321923', '#ef5c70'), 'light-dark(color-mix(in srgb,#ef5c70 30%,white),#321923)');
  assert.equal(themeChannelColor('canvas', '#211218', '#ef5c70'), 'light-dark(color-mix(in srgb,#211218 10%,white),#211218)');
  assert.equal(themeChannelColor('sidebar', '#1b1015', '#ef5c70'), 'light-dark(color-mix(in srgb,#1b1015 10%,white),#1b1015)');
});

test('the original 12 hue presets and dark neutral remain valid', () => {
  const map = validateMap(structuredClone(initial));
  assert.equal(Object.keys(map.themes).length, 13);
  assert.equal(map.themes.neutral.canvas, '#181818');
  assert.equal(map.defaultTheme, 'neutral');
  assert.equal(map.uiFontSizeOverride, null);
});

test('tasks inherit project colors, explicit native wins, and unrelated project colors never leak', () => {
  const map = validateMap({ ...structuredClone(initial), projects: { Alpha: 'red', Beta: 'blue' }, tasks: { 'local:one': 'native' } });
  assert.equal(resolveTheme(map, { taskKey: 'local:new', projectName: 'Beta' }).themeId, 'blue');
  assert.equal(resolveTheme(map, { taskKey: 'local:one', projectName: 'Alpha' }).theme, null);
  assert.equal(resolveTheme(map, { taskKey: 'local:new', projectName: 'Alpha' }).themeId, 'red');
  assert.equal(resolveTheme(map).themeId, 'native');
  assert.equal(canonicalTaskKey('one'), 'local:one');
  assert.equal(canonicalTaskKey('remote-control:host:one'), 'remote-control:host:one');
  assert.equal(canonicalTaskKey('one', 'remote-control:host'), 'remote-control:host:one');
});

test('project IDs and memberships are authoritative; cwd matching respects Windows path boundaries', () => {
  const projects = { a: { id: 'a', name: 'Alpha', rootPaths: ['S:/dev/Alpha'] }, b: { id: 'b', name: 'Beta', rootPaths: ['S:/dev/Beta'] } };
  assert.equal(projectNameForThread('local:one', { one: 'a' }, projects, 'S:/dev/Beta'), 'Alpha');
  assert.equal(projectNameForThread('local:one', { one: 'a' }, projects, 'S:/dev/Alpha', 'b'), 'Beta');
  assert.equal(projectNameForThread('local:new', {}, projects, '\\\\?\\S:\\dev\\Beta\\sub'), 'Beta');
  assert.equal(projectNameForThread('local:new', {}, projects, 'S:/dev/Betamax'), null);
  const nested = [{ name: 'Parent', rootPaths: ['S:/dev', 'S:/unrelated/very/long/path'] }, { name: 'Child', rootPaths: ['S:/dev/Child'] }];
  assert.equal(projectNameForThread('local:new', {}, nested, 'S:/dev/Child/work'), 'Child');
});

test('invalid colors, font sizes and assignments stay explicit; object prototype keys are not themes', () => {
  for (const size of [10, 25, '20', 20.5]) assert.throws(() => validateMap({ ...structuredClone(initial), uiFontSizeOverride: size }), ThemeConfigError);
  assert.throws(() => validateMap({ ...structuredClone(initial), enabledColors: null }), ThemeConfigError);
  assert.throws(() => validateMap({ ...structuredClone(initial), projects: { Alpha: 'inherit' } }), ThemeConfigError);
  assert.throws(() => validateMap({ ...structuredClone(initial), tasks: { 'local:one': 'constructor' } }), ThemeConfigError);
  assert.throws(() => validateMap({ ...structuredClone(initial), themes: { broken: { accent: 'red' } } }), ThemeConfigError);
});

test('font and color CSS retain their own scope, do not recolor right-panel fades or change code fonts', () => {
  const css = themeCss({ ...initial, uiFontSizeOverride: 20 });
  assert.match(css, /--vscode-font-size:20px/);
  assert.match(css, /--text-base:20px/);
  assert.doesNotMatch(css, /--vscode-editor-font-size|--codex-chat-code-font-size|font-family/);
  assert.match(css, /not\(\[data-app-shell-tab-panel-controller="right"\] \*\)/);
  assert.doesNotMatch(themeCss(initial), /--text-base:/);
});
