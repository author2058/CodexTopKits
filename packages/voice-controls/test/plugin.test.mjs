import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import voicePlugin from '../src/index.mjs';
import { voicePayload } from '../src/payload.mjs';
import voiceKit from '../kits/voice-volume/index.mjs';
import { createLocalization } from '../../core/src/localization.mjs';
import { createManagementI18n } from '../../core/src/management-localization.mjs';

const i18n = { t: (messages, key) => messages.en[key], onChange: () => () => {} };

test('serialized voice payload contains no unresolved imports', () => {
  new vm.Script(voicePayload({ epoch: 'fixture' }));
});

test('voice Kit refuses hosts without restart preflight and leaves existing ownership untouched', () => {
  const owner = {}, document = { defaultView: { __CODEX_DESKTOP_TOOLKIT_VOICE__: owner } };
  assert.throws(() => voiceKit.create({ document }, voiceKit.helpers), /requires Core 0\.3\.18/);
  assert.throws(() => voiceKit.create({ document, restartPreflight: true, i18n }, voiceKit.helpers), /already has an owner/);
  assert.equal(document.defaultView.__CODEX_DESKTOP_TOOLKIT_VOICE__, owner);
});

test('voice Kit forwards status to the existing management owner without sharing control ownership', () => {
  const reports = [], errors = [], view = { location: { pathname: '/index.html' }, crypto: { randomUUID: () => 'fixture' }, __CDTK_VOICE_BRIDGE__: value => reports.push(JSON.parse(value)) };
  view.top = view;
  const helpers = { installVoiceRenderer(target, _initial, _helpers, options) {
    target.__CODEXTOPKITS_VOICE__ = { status: () => ({ ready: true }), cleanup() { delete target.__CODEXTOPKITS_VOICE__; } };
    target[options.binding](JSON.stringify({ applicable: true, status: { ready: true }, error: null }));
  } };
  const owner = voiceKit.create({ document: { defaultView: view }, restartPreflight: true, i18n, reportError: error => errors.push(error) }, helpers);
  assert.equal(reports[0].status.ready, true); assert.deepEqual(errors, [null]);
  owner.close(); assert.equal(reports.at(-1).disabled, true); assert.equal(view.__CODEXTOPKITS_VOICE__, undefined);
});

test('legacy Voice management can hand off controls without injecting or removing the Kit owner', async t => {
  const calls = [], health = [];
  const client = { closed: false, handlers: new Set(), targets: () => [{ type: 'page', url: 'app://-/index.html', targetId: 'main' }],
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Runtime.evaluate') return { result: { value: params.expression.includes('const voice=') ? { applicable: true, status: { ready: true }, error: null } : true } };
      return {};
    }, async close() { this.closed = true; } };
  const plugin = await voicePlugin({ externalKit: true }).start({ log: async () => {}, setHealth: value => health.push(value), cdp: { acquire: async () => client, onReconnect: () => () => {} } });
  await new Promise(resolve => setImmediate(resolve));
  const state = await plugin.check();
  assert.equal(state.windows[0].status.ready, true); assert.equal(health.at(-1).ok, true);
  assert.equal(health.at(-1).messageLocales.en, 'Voice controls connected to 1 window.');
  assert.ok(!calls.some(call => call.method === 'Page.addScriptToEvaluateOnNewDocument'));
  assert.ok(calls.some(call => call.params.expression === 'window.__CODEXTOPKITS_VOICE__?.refresh()'));
  await plugin.close();
  assert.ok(!calls.some(call => call.params.expression === 'window.__CODEX_DESKTOP_TOOLKIT_VOICE__?.cleanup()'));
});

test('management script parses as a standalone page', async () => {
  const html = await fs.readFile(new URL('../assets/voice-manager.html', import.meta.url), 'utf8');
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test('management locale changes rerender cached status without reconnecting or changing native diagnostics', async () => {
  const html = await fs.readFile(new URL('../assets/voice-manager.html', import.meta.url), 'utf8');
  const nodes = Object.fromEntries(['check', 'status', 'errors', 'windows'].map(id => [id, { textContent: '', innerHTML: '', addEventListener() {} }]));
  const sources = []; let fetches = 0;
  const state = { revision: 1, errors: [{ message: 'native <failure>' }], windows: [{ targetId: 'main', applicable: true, status: { ready: true, active: true } }] };
  const document = { hidden: false, documentElement: { lang: 'en' }, querySelectorAll: () => [], getElementById: id => nodes[id], addEventListener() {}, removeEventListener() {} };
  const window = { addEventListener() {}, removeEventListener() {} };
  class EventSource { constructor(url) { this.url = url; sources.push(this); } close() {} }
  const fetch = async path => { fetches++; return { ok: true, json: async () => path === 'api/state' ? state : { preference: { mode: 'fixed', locale: 'en' } } }; };
  window.createCodexTopKitsManagementI18n = options => createManagementI18n(createLocalization, options, { document, window, EventSource, AbortController, fetch });
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { window, document, EventSource, fetch });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.status.textContent, 'Found 1 issues'); assert.match(nodes.windows.innerHTML, /Call active in this window/);
  assert.equal(nodes.errors.innerHTML, '<li>native &lt;failure&gt;</li>');
  const language = sources.find(source => source.url === '../../api/events'), voice = sources.find(source => source.url === 'api/events');
  language.onmessage({ data: JSON.stringify({ languagePreference: { mode: 'fixed', locale: 'zh-Hans' } }) });
  assert.equal(nodes.status.textContent, '发现 1 个问题'); assert.match(nodes.windows.innerHTML, /本窗口正在通话/);
  assert.equal(nodes.errors.innerHTML, '<li>native &lt;failure&gt;</li>'); assert.equal(fetches, 2); assert.equal(sources.length, 2);
  voice.onerror(); language.onmessage({ data: JSON.stringify({ languagePreference: { mode: 'fixed', locale: 'en' } }) }); assert.match(nodes.status.textContent, /Connection interrupted/);
});

test('voice Kit subscribes once and releases its locale callback on close', () => {
  let callback, subscriptions = 0, unsubscriptions = 0, updates = 0, locale = 'en';
  const view = { location: { pathname: '/' }, crypto: { randomUUID: () => 'fixture' } }; view.top = view;
  const language = { t: (messages, key) => messages[locale][key], onChange(fn) { subscriptions++; callback = fn; return () => unsubscriptions++; } };
  const owner = voiceKit.create({ document: { defaultView: view }, restartPreflight: true, i18n: language, reportError() {} }, { installVoiceRenderer(target, _initial, _helpers, options) {
    target.__CODEXTOPKITS_VOICE__ = { renderText() { updates++; assert.equal(options.translate('auto'), '自动'); }, cleanup() {} };
  } });
  locale = 'zh-Hans'; callback(); assert.equal(updates, 1); assert.equal(subscriptions, 1);
  owner.close(); assert.equal(unsubscriptions, 1);
});

test('closing Voice cancels its own pending CDP acquisition without starting a native call', async () => {
  let aborted = false;
  const plugin = await voicePlugin().start({ log: async () => {}, setHealth() {}, cdp: { onReconnect: () => () => {}, acquire: ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) } });
  await plugin.close(); assert.equal(aborted, true);
});

test('health preserves original native errors, and checks never reinstall an active call', async t => {
  const scripts = [], health = [];
  const client = { closed: false, handlers: new Set(), targets: () => [{ type: 'page', url: 'app://-/index.html', targetId: 'main' }],
    async send(method, params) {
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') { scripts.push(params.source); return { identifier: 'script' }; }
      if (method === 'Runtime.evaluate') return { result: { value: {} } };
      return {};
    }, async close() { this.closed = true; } };
  const plugin = await voicePlugin().start({ log: async () => {}, setHealth: value => health.push(value), cdp: { acquire: async () => client, onReconnect: () => () => {} } });
  t.after(() => plugin.close()); await new Promise(resolve => setImmediate(resolve));
  const error = new TypeError('native microphone changed');
  for (const handler of client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'session', params: { name: '__CDTK_VOICE_BRIDGE__', payload: JSON.stringify({ applicable: true, status: { ready: true, active: true, state: { sessionKey: 'call' } }, error: { name: error.name, message: error.message, stack: error.stack } }) } });
  assert.equal(health.at(-1).issueCount, 1); assert.equal(health.at(-1).ok, false);
  assert.equal(health.at(-1).messageLocales, undefined); assert.equal(health.at(-1).message, error.message);
  const state = await plugin.check(); assert.equal(state.errors[0].stack, error.stack);
  const epoch = source => source.match(/"epoch":"([^"]+)"/)[1];
  assert.equal(epoch(scripts[0]), epoch(scripts.at(-1)));
  const response = await plugin.management.request({ method: 'GET', url: new URL('http://127.0.0.1/') }); assert.match(response.body, /Codex voice volume/);
});
