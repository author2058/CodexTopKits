import test from 'node:test';
import assert from 'node:assert/strict';
import { installThemeRenderer } from '../src/renderer.mjs';
import { canonicalTaskKey, projectNameForThread, resolveTheme } from '../src/model.mjs';
import { createNativeBridgeClient } from 'codex-toolkit-core/renderer';

function fixture() {
  const document = new EventTarget(), window = new EventTarget(), reports = [], maps = [];
  document.readyState = 'loading';
  document.documentElement = null;
  document.querySelectorAll = () => [];
  document.querySelector = document.getElementById = () => null;
  Object.assign(window, { document, location: { pathname: '/index.html' }, queueMicrotask,
    MutationObserver: class { observe(element) { assert.ok(element); } disconnect() {} },
    __CDTK_THEMES_REPORT__: value => reports.push(JSON.parse(value)),
  });
  window.top = window;
  const helpers = { canonicalTaskKey, projectNameForThread, createNativeBridgeClient,
    resolveTheme(map, context) { maps.push(map); return resolveTheme(map, context); },
    themeCss() { throw new Error('A non-main fixture must not install CSS.'); },
    createNativeAssetReader: () => ({}), loadNativeAppServices() { throw new Error('A non-main fixture must not read native data.'); },
  };
  const map = { defaultTheme: 'native', themes: {}, tasks: {}, projects: {}, enabledColors: {}, uiFontSizeOverride: null };
  const ready = () => {
    document.readyState = 'interactive';
    document.documentElement = { classList: { contains: () => false }, style: { getPropertyValue: () => '', removeProperty() {} } };
    document.dispatchEvent(new Event('DOMContentLoaded'));
  };
  return { window, map, helpers, maps, reports, ready };
}

test('document-start injection waits for DOM readiness and retains the latest map', async () => {
  const view = fixture();
  assert.deepEqual(installThemeRenderer(view.window, view.map, view.helpers), { applicable: false, pending: true });
  const latest = { ...view.map, uiFontSizeOverride: 20 };
  view.window.__CODEX_DESKTOP_TOOLKIT_THEMES__.update(latest);
  assert.equal(view.reports.length, 0);
  view.ready();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.maps.at(-1), latest);
  assert.equal(view.reports.at(-1).errors.length, 0);
  view.window.__CODEX_DESKTOP_TOOLKIT_THEMES__.cleanup();
});

test('stopping before DOM readiness cancels the pending injection', () => {
  const view = fixture();
  installThemeRenderer(view.window, view.map, view.helpers);
  view.window.__CODEX_DESKTOP_TOOLKIT_THEMES__.cleanup();
  view.ready();
  assert.equal(view.window.__CODEX_DESKTOP_TOOLKIT_THEMES__, undefined);
  assert.equal(view.reports.length, 0);
});

test('a deferred startup failure is reported through the existing health binding', () => {
  const view = fixture();
  installThemeRenderer(view.window, view.map, view.helpers);
  view.window.__CODEX_DYNAMIC_THEME__ = {};
  view.ready();
  assert.equal(view.reports[0].errors[0].source, 'startup');
  assert.match(view.reports[0].errors[0].message, /旧主题控制器/);
});
