import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalization } from '../src/localization.mjs';
import { createManagementI18n } from '../src/management-localization.mjs';
import { createPluginHost } from '../src/index.mjs';

const messages = { en: { title: 'Settings', hint: 'Current settings' }, 'zh-Hans': { title: '设置', hint: '当前设置' } };
function fixture(fetch) {
  const sources = [], documentEvents = new Map(), windowEvents = new Map();
  const node = { textContent: 'Settings', writes: 0, attributes: new Map([['data-i18n', 'title'], ['data-i18n-title', 'hint']]),
    getAttribute(key) { return this.attributes.get(key) ?? null; }, setAttribute(key, value) { this.writes++; this.attributes.set(key, value); } };
  const document = { documentElement: { lang: 'en', style: {} }, hidden: false, querySelectorAll: () => [node],
    addEventListener: (key, value) => documentEvents.set(key, value), removeEventListener: key => documentEvents.delete(key) };
  const window = { navigator: { language: 'zh-CN' }, addEventListener: (key, value) => windowEvents.set(key, value), removeEventListener: key => windowEvents.delete(key) };
  class EventSource { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } }
  return { node, sources, documentEvents, windowEvents, environment: { document, window, fetch, EventSource, AbortController } };
}

test('desktop page uses host then system, preserves bindings, and rejects stale initial state', async () => {
  let resolve, reads = 0, changes = 0;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture(() => { reads++; return pending; }), errors = [];
  const api = createManagementI18n(createLocalization, { messages, onChange: () => { changes++; }, onError: error => errors.push(error) }, f.environment);
  const { t } = api; assert.equal(t('title'), 'Settings'); assert.equal(changes, 0);
  await Promise.resolve();
  const emit = state => f.sources.at(-1).onmessage({ data: JSON.stringify(state) });
  emit({ languagePreference: { mode: 'auto' }, hostLanguage: 'zh-CN', systemLanguage: 'en-US' });
  assert.equal(f.node.textContent, '设置'); assert.equal(api.locale, 'zh-Hans');
  resolve({ ok: true, json: async () => ({ preference: { mode: 'auto' }, hostLanguage: 'en-US', systemLanguage: 'zh-CN' }) });
  await api.ready; assert.equal(api.locale, 'zh-Hans');
  const count = changes, writes = f.node.writes;
  emit({ languagePreference: { mode: 'fixed', locale: 'zh-Hans' } });
  assert.equal(changes, count); assert.equal(f.node.writes, writes);
  emit({ languagePreference: { mode: 'auto' }, hostLanguage: 'en-US', systemLanguage: 'zh-CN' });
  assert.equal(api.locale, 'en'); assert.equal(f.node.textContent, 'Settings');
  emit({ languagePreference: { mode: 'auto' }, hostLanguage: null, systemLanguage: 'en-US' });
  assert.equal(api.locale, 'en');
  emit({ languagePreference: { mode: 'auto' }, hostLanguage: 'fr-FR', systemLanguage: 'zh-CN' });
  assert.equal(api.locale, 'en'); assert.equal(reads, 1);
  f.environment.document.hidden = true; f.documentEvents.get('visibilitychange')(); assert.equal(f.sources[0].closed, true);
  f.environment.document.hidden = false; f.documentEvents.get('visibilitychange')(); assert.equal(f.sources.length, 2); assert.equal(reads, 1);
  api.close(); api.close(); assert.equal(f.sources[1].closed, true); assert.equal(f.documentEvents.size, 0); assert.equal(f.windowEvents.size, 0); assert.deepEqual(errors, []);
});

test('page errors retain their original identity and close cancels initial work', async () => {
  const original = new SyntaxError('fixture decoding failed'), errors = [];
  const f = fixture(async () => { throw original; });
  const api = createManagementI18n(createLocalization, { messages, onError: error => errors.push(error) }, f.environment);
  await assert.rejects(api.ready, error => error === original); assert.equal(errors[0], original); api.close();
  let calls = 0;
  const stopped = createManagementI18n(createLocalization, { messages, onError: error => { throw error; } }, fixture(() => { calls++; }).environment);
  stopped.close(); await stopped.ready; assert.equal(calls, 0);
});

test('settings appearance follows host state even when locale stays unchanged', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture(() => pending), errors = [];
  const api = createManagementI18n(createLocalization, { messages, onError: error => errors.push(error) }, f.environment);
  await Promise.resolve();
  const state = { languagePreference: { mode: 'auto' }, hostLanguage: 'en-US', hostAppearance: 'light' };
  const emit = value => f.sources.at(-1).onmessage({ data: JSON.stringify(value) });
  emit(state); assert.equal(f.environment.document.documentElement.style.colorScheme, 'light');
  resolve({ ok: true, json: async () => ({ ...state, hostAppearance: 'dark' }) });
  await api.ready; assert.equal(f.environment.document.documentElement.style.colorScheme, 'light');
  emit({ ...state, hostAppearance: 'dark' }); assert.equal(api.locale, 'en');
  assert.equal(f.environment.document.documentElement.style.colorScheme, 'dark');
  emit({ ...state, hostAppearance: null }); assert.equal(f.environment.document.documentElement.style.colorScheme, '');
  emit({ ...state, hostAppearance: 'unexpected' }); assert.match(errors[0].message, /Invalid host appearance/);
  api.close(); assert.equal(f.sources.at(-1).closed, true);
});

test('health translations follow shared preference without rerunning plugins or rewriting diagnostics', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-health-locale-'));
  let setHealth, starts = 0;
  const host = await createPluginHost({ stateDirectory, plugins: [{ id: 'fixture', coreApiVersion: 1, start: async context => {
    starts++; setHealth = context.setHealth;
    setHealth({ ok: true, message: 'Original status', messageLocales: { en: 'Ready', 'zh-Hans': '就绪' } });
    return { close() {} };
  } }] });
  t.after(() => host.close());
  await host.setLanguagePreference({ mode: 'fixed', locale: 'en' }); assert.equal(host.health().plugins[0].message, 'Ready');
  await host.setLanguagePreference({ mode: 'fixed', locale: 'zh-Hans' }); assert.equal(host.health().plugins[0].message, '就绪'); assert.equal(starts, 1);
  assert.equal(Object.hasOwn(host.health().plugins[0], 'messageLocales'), false);
  setHealth({ ok: true, message: '原生 diagnostic unchanged' });
  await host.setLanguagePreference({ mode: 'fixed', locale: 'en' }); assert.equal(host.health().plugins[0].message, '原生 diagnostic unchanged');
  assert.throws(() => setHealth({ ok: true, message: 'invalid', messageLocales: { 'zh-Hans': '无英文' } }), /Invalid localized plugin health/);
});
