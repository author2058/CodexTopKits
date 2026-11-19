import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { startRuntime, requestRuntime } from '../src/runtime.mjs';

test('one owner serves plugin pages, status and checks with origin and action validation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-manager-'));
  let checks = 0;
  const runtime = await startRuntime({ stateDirectory: directory, plugins: [{ id: 'features', coreApiVersion: 1,
    start: async () => ({ close: async () => {}, management: { title: 'Kits', request: async () => null } }),
  }, { id: 'fixture', coreApiVersion: 1,
    start: async () => ({ close: async () => {}, check: async () => { checks++; }, management: { title: 'fixture <page>',
      request: async ({ url }) => url.pathname === '/' ? { body: { fixture: true } } : null } }),
  }] });
  t.after(() => runtime.close());
  const { managerUrl } = await requestRuntime(directory, 'status');
  const html = await (await fetch(managerUrl)).text();
  assert.match(html, /<title>CodexTopKits<\/title>/); assert.match(html, /<h1>CodexTopKits<\/h1>/);
  assert.match(html, /fixture &lt;page&gt;/);
  assert.ok(html.indexOf('id="management-fixture"') < html.indexOf('id="management-features"'));
  assert.match(html, /id="management-features" href="plugins\/features\/">All Kits<\/a>/);
  assert.match(html, /"zh-Hans":"全部Kits"/);
  assert.match(html, /pre\{[^}]*border-radius:6px[^}]*background:light-dark\(#8080800d,#8080801a\)/);
  const languageScript = await fetch(managerUrl + 'management-localization.js');
  assert.equal(languageScript.status, 200); assert.match(languageScript.headers.get('content-type'), /javascript; charset=utf-8/);
  const languageContext = {};
  vm.runInNewContext(await languageScript.text(), languageContext);
  assert.equal(typeof languageContext.createCodexTopKitsManagementI18n, 'function');
  assert.deepEqual(await (await fetch(managerUrl + 'plugins/fixture/')).json(), { fixture: true });
  assert.equal((await fetch(managerUrl + 'api/check', { method: 'POST' })).status, 403);
  assert.equal((await fetch(managerUrl, { headers: { origin: 'https://external.invalid' } })).status, 403);
  assert.equal((await fetch(new URL('/wrong/', managerUrl))).status, 404);
  assert.equal((await fetch(managerUrl + 'api/check', { method: 'POST', headers: { 'x-codex-toolkit-action': 'manage' } })).status, 200);
  assert.equal(checks, 1);
  await runtime.close();
  await assert.rejects(fetch(managerUrl));
});

test('plugin event streams use the same protected manager and release subscriptions on close', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-manager-events-'));
  const listeners = new Set();
  const runtime = await startRuntime({ stateDirectory: directory, plugins: [{ id: 'events', coreApiVersion: 1,
    start: async () => ({ close: async () => {}, management: { request: async () => ({ subscribe(listener) {
      listeners.add(listener); listener({ revision: 1 }); return () => listeners.delete(listener);
    } }) } }),
  }] });
  t.after(() => runtime.close());
  const response = await fetch(runtime.status().managerUrl + 'plugins/events/');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"revision":1}\n\n');
  for (const listener of listeners) listener({ revision: 2 });
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"revision":2}\n\n');
  await runtime.close();
  assert.equal(listeners.size, 0);
  await reader.cancel().catch(error => { if (!/terminated/i.test(error.message)) throw error; });
});

test('manager streams health changes and recovered states without rechecking plugins', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-manager-health-'));
  let setHealth, setHostLanguage, checks = 0;
  const runtime = await startRuntime({ stateDirectory: directory, plugins: [{ id: 'fixture', coreApiVersion: 1,
    start: async context => { setHealth = context.setHealth; setHostLanguage = context.setHostLanguage; setHostLanguage('en-US'); return { close: async () => {}, check: async () => { checks++; }, management: { title: { en: 'Test settings', 'zh-Hans': '测试设置' }, request: async () => null } }; },
  }] });
  t.after(() => runtime.close());
  const managerUrl = runtime.status().managerUrl;
  const html = await (await fetch(managerUrl)).text();
  assert.match(html, /new EventSource\('api\/events'\)/);
  assert.match(html, /<option value="auto">Auto<\/option><option value="en">English<\/option><option value="zh-Hans">简体中文<\/option>/);
  class Element {
    constructor() { this.children = []; this.value = ''; this.className = ''; this.content = ''; }
    get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.content = value; this.children = []; }
    get lastElementChild() { return this.children.at(-1); }
    append(child) { child.parent = this; this.children.push(child); }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  }
  const status = new Element(), button = {}, language = { value: 'auto', options: [{ textContent: 'Auto' }] }, sources = [];
  const elements = { status, check: button, language, 'language-label': {}, empty: {}, 'management-fixture': {} };
  const document = { documentElement: { lang: 'en', style: {} }, getElementById: id => elements[id] ?? null, createElement: () => new Element() };
  let requestError;
  class FakeEventSource { constructor(url) { this.url = url; sources.push(this); } }
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document, navigator: { language: 'zh-CN' }, EventSource: FakeEventSource,
    fetch: (url, options) => requestError ? Promise.reject(requestError) : fetch(managerUrl + url, options),
  });
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(elements['language-label'].textContent, 'Language');
  assert.equal(elements['management-fixture'].textContent, 'Test settings');
  sources[0].onmessage({ data: JSON.stringify({ health: { plugins: [{ id: 'fixture', ok: false, message: 'fixture timeout' }] } }) });
  assert.match(status.textContent, /Error: fixture — fixture timeout/);
  const retained = status.children[0]; assert.equal(retained.className, 'error');
  sources[0].onmessage({ data: JSON.stringify({ health: { plugins: [{ id: 'fixture', ok: true, message: 'fixture recovered' }] } }) });
  assert.match(status.textContent, /OK: fixture — fixture recovered/);
  assert.equal(status.children[0], retained); assert.equal(retained.className, '');
  sources[0].onmessage({ data: JSON.stringify({ health: { plugins: [{ id: 'fixture', ok: true, message: 'fixture recovered' }, { id: 'other', ok: false, message: 'failed' }] } }) });
  assert.equal(status.children[0].className, ''); assert.equal(status.children[1].className, 'error');
  sources[0].onmessage({ data: JSON.stringify({ health: { plugins: [{ id: 'fixture', ok: true, message: 'fixture recovered' }] } }) });
  assert.equal(status.children.length, 1);
  const response = await fetch(managerUrl + 'api/events');
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6).trim());
  const deliver = data => sources[0].onmessage({ data: JSON.stringify(data) });
  const initial = await read(); assert.equal(initial.health.plugins[0].ok, true); deliver(initial);
  language.value = 'zh-Hans'; await language.onchange({ target: language }); deliver(await read());
  assert.equal(document.documentElement.lang, 'zh-Hans'); assert.equal(elements['language-label'].textContent, '语言');
  assert.equal(button.textContent, '检查已安装功能'); assert.equal(language.options[0].textContent, '自动');
  assert.equal(elements['management-fixture'].textContent, '测试设置');
  assert.match(status.textContent, /正常：fixture — /);
  assert.equal((await (await fetch(managerUrl + 'api/localization')).json()).preference.locale, 'zh-Hans');
  setHostLanguage('fr-FR'); deliver(await read()); assert.equal(document.documentElement.lang, 'zh-Hans');
  language.value = 'auto'; await language.onchange({ target: language }); deliver(await read());
  assert.equal(language.value, 'auto'); assert.equal(document.documentElement.lang, 'en');
  deliver({ ...initial, languagePreference: { mode: 'auto' }, hostLanguage: 'fr-FR', systemLanguage: 'zh-CN' });
  assert.equal(document.documentElement.lang, 'en');
  setHostLanguage('zh-CN'); deliver(await read()); assert.equal(document.documentElement.lang, 'zh-Hans');
  language.value = 'en'; await language.onchange({ target: language }); deliver(await read());
  assert.equal(document.documentElement.lang, 'en');
  language.value = 'auto'; await language.onchange({ target: language }); deliver(await read());
  assert.equal(document.documentElement.lang, 'zh-Hans');
  setHostLanguage('en-US'); deliver(await read()); assert.equal(document.documentElement.lang, 'en');
  setHealth({ ok: false, message: 'fixture timeout' });
  const pendingEvent = await read(); deliver(pendingEvent);
  const pending = pendingEvent.health.plugins[0];
  assert.equal(pending.recovering, true); assert.equal(pending.issueCount, 0);
  assert.equal(status.textContent, 'OK: fixture — ' + pending.message);
  setHealth({ ok: true, message: 'fixture recovered' });
  const recovered = await read(); deliver(recovered);
  assert.equal(recovered.health.plugins[0].message, 'fixture recovered');
  assert.match(status.textContent, /OK: fixture — fixture recovered/);
  assert.equal(checks, 0);
  await button.onclick(); assert.equal(checks, 1); assert.equal(button.disabled, false);
  requestError = new Error('language request failed'); language.value = 'zh-Hans';
  await assert.rejects(language.onchange({ target: language }), error => error === requestError);
  assert.equal(status.textContent, 'language request failed'); assert.equal(language.value, 'auto');
  assert.equal(status.children[0].className, 'error');
  await reader.cancel();
});
