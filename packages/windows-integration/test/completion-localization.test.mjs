import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { featureModule } from 'codex-toolkit-core/features';
import { createLocalization } from '../../core/src/localization.mjs';
import { createManagementI18n } from '../../core/src/management-localization.mjs';
import { installReadAloudMenu } from '../src/read-aloud-menu.mjs';
import { createMarkdownReadAloud } from '../kits/markdown-edge-read-aloud/index.mjs';
import kit from '../kits/markdown-edge-read-aloud/index.mjs';
import { featureDom } from './feature-dom.mjs';

test('Markdown native menu resolves its label when opened and retains native actions', async () => {
  const fixture = featureDom(), { document, events } = fixture, menus = [], actions = [];
  let locale = 'en', nativeSelected = 0;
  document.defaultView.electronBridge = { async showContextMenu(items) { menus.push(items); return { id: menus.length === 1 ? 'native' : 'cdtk-read-aloud' }; } };
  const item = document.createElement('a'); item.setAttribute('data-file-reference', 'true'); item.setAttribute('data-prompt-link-href', 'example.md');
  item.__reactFiber$fixture = { memoizedProps: { getItems: () => [{ id: 'native', label: 'Native action', onSelect: () => nativeSelected++ }] } };
  const previousNode = globalThis.Node; globalThis.Node = { ELEMENT_NODE: 1 };
  const menu = installReadAloudMenu(document, value => actions.push(value), error => { throw error; }, () => locale === 'en' ? 'Open and read aloud with Microsoft Edge' : '用 Microsoft Edge 打开并朗读');
  try {
    menu.refresh();
    const open = () => events.get('contextmenu')({ composedPath: () => [item], preventDefault() {}, stopImmediatePropagation() {} });
    open(); await new Promise(resolve => setImmediate(resolve));
    locale = 'zh-Hans'; open(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(menus[0].at(-1).label, 'Open and read aloud with Microsoft Edge');
    assert.equal(menus[1].at(-1).label, '用 Microsoft Edge 打开并朗读');
    assert.equal(menus[1][0].label, 'Native action'); assert.equal(nativeSelected, 1);
    assert.deepEqual(actions, [{ kind: 'read-aloud', path: 'example.md', cwd: null }]);
  } finally { menu.cleanup(); globalThis.Node = previousNode; }
  assert.equal(events.has('contextmenu'), false);
});

test('packed Markdown Kit supplies its shared locale dynamically without remounting the menu', async () => {
  assert.equal(kit.manifest.version, '0.1.3'); assert.equal(kit.manifest.minimumCoreVersion, '0.3.39');
  const packed = (await import('data:text/javascript;base64,' + Buffer.from(featureModule(kit), 'utf8').toString('base64'))).default;
  const { document } = featureDom(); let locale = 'en', label, mounts = 0, cleanups = 0;
  const context = { document, serviceVersionChecks: true, i18n: { t: (messages, key) => messages[locale][key] }, onDomChange: () => () => {}, dispatch() {}, reportError() {} };
  const instance = packed.create(context, { installReadAloudMenu(_document, _send, _error, getLabel) { mounts++; label = getLabel; return { refresh() {}, cleanup() { cleanups++; } }; } });
  assert.equal(label(), 'Open and read aloud with Microsoft Edge'); locale = 'zh-Hans';
  assert.equal(label(), '用 Microsoft Edge 打开并朗读'); assert.equal(mounts, 1);
  instance.close(); assert.equal(cleanups, 1);
  assert.throws(() => createMarkdownReadAloud({ document }, {}), /requires Core 0\.3\.39/);
});

test('Windows management page switches cached labels without new requests or losing native details', async () => {
  const page = await fs.readFile(new URL('../assets/windows-manager.html', import.meta.url), 'utf8');
  assert.match(page, /<script src="\.\.\/\.\.\/management-localization\.js"><\/script>/);
  const script = page.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const nodes = Object.fromEntries(['errors', 'windows', 'status', 'check'].map(id => [id, { innerHTML: '', textContent: '', hidden: false, addEventListener(name, callback) { this[name] = callback; } }]));
  const state = { revision: 1, errors: [{ message: 'Native <failure>' }], windows: [{ title: '原始 <title>', status: 'active', handle: 123 }], autoSleep: { enabled: true } };
  const heading = { textContent: 'Windows integration', getAttribute: name => name === 'data-i18n' ? 'heading' : null };
  const documentEvents = new Map(), windowEvents = new Map(), streams = [];
  const add = (events, name, callback) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); };
  const remove = (events, name, callback) => events.get(name)?.delete(callback);
  let requests = 0;
  const document = { hidden: false, documentElement: { lang: 'en' }, getElementById: id => nodes[id], querySelectorAll: () => [heading], addEventListener: (name, callback) => add(documentEvents, name, callback), removeEventListener: (name, callback) => remove(documentEvents, name, callback) };
  const window = { addEventListener: (name, callback) => add(windowEvents, name, callback), removeEventListener: (name, callback) => remove(windowEvents, name, callback) };
  class EventSource { constructor(path) { this.path = path; this.closed = false; streams.push(this); } close() { this.closed = true; } }
  const fetch = async path => { requests++; return { ok: true, json: async () => path.endsWith('api/localization') ? { preference: { mode: 'auto' }, hostLanguage: 'en-US', systemLanguage: 'zh-CN' } : state }; };
  window.createCodexTopKitsManagementI18n = options => createManagementI18n(createLocalization, options, { document, window, EventSource, AbortController, fetch });
  vm.runInNewContext(script, { document, window, EventSource, fetch, JSON });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.windows.innerHTML, /原始 &lt;title&gt;/); assert.match(nodes.errors.innerHTML, /Native &lt;failure&gt;/);
  assert.match(nodes.status.textContent, /Found 1 issues/); const button = nodes.check, requestCount = requests, streamCount = streams.length;
  streams.find(stream => stream.path === '../../api/events').onmessage({ data: JSON.stringify({ languagePreference: { mode: 'fixed', locale: 'zh-Hans' }, hostLanguage: 'en-US', systemLanguage: 'zh-CN' }) });
  assert.match(nodes.windows.innerHTML, /运行中/); assert.match(nodes.windows.innerHTML, /原始 &lt;title&gt;/);
  assert.match(nodes.errors.innerHTML, /Native &lt;failure&gt;/); assert.equal(nodes.status.textContent, '发现 1 个问题');
  assert.equal(heading.textContent, 'Windows 窗口集成'); assert.equal(document.documentElement.lang, 'zh-Hans');
  assert.equal(nodes.check, button); assert.equal(requests, requestCount); assert.equal(streams.length, streamCount);
  for (const callback of [...windowEvents.get('pagehide')]) callback(); assert.ok(streams.every(stream => stream.closed));
});
