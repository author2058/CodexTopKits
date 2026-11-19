import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createLocalization } from '../src/localization.mjs';

test('Kit manager checks updates only on request and prepares the selected Kit', async () => {
  const html = await fs.readFile(new URL('../assets/features.html', import.meta.url), 'utf8');
  assert.match(html, /<title data-i18n="title">Kits<\/title>/);
  assert.match(html, /#status,#error\{[^}]*border-radius:6px[^}]*background:light-dark\(#8080800d,#8080801a\)/);
  assert.match(html, /#status:empty,#error:empty\{display:none\}/);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  class Element {
    constructor() { this.children = []; this.textContent = ''; this.value = ''; this.attributes = {}; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    remove() { this.removed = true; }
  }
  const nodes = Object.fromEntries(['features', 'available-kits', 'catalog', 'error', 'status', 'updates', 'update-repository', 'github-token', 'check-updates', 'update-result', 'restart', 'install-directory', 'prepare-install'].map(id => [id, new Element()]));
  const document = { getElementById: id => nodes[id], createElement: () => new Element() };
  const feature = { id: 'footer', version: '0.1.0', enabled: true, desired: true, dependencies: {}, prepared: null, available: null };
  const state = { phase: 'running', hostPid: 10, errors: [], updateRepository: 'owner/repo', features: [feature], availableKits: [] };
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'api/check-updates') { feature.available = { version: '0.2.0' }; state.availableKits = [{ id: 'extra', version: '0.1.0' }]; }
    if (url === 'api/prepare-update') feature.prepared = { version: '0.2.0' };
    if (url === 'api/prepare-available-install') { state.availableKits = []; state.features.push({ id: 'extra', version: '0.1.0', installed: false, enabled: false, desired: true, dependencies: {}, prepared: { version: '0.1.0' } }); }
    return { ok: true, json: async () => state };
  };
  class EventSource { constructor(url) { this.url = url; } }
  let locale = 'en', change;
  const window = { createCodexTopKitsManagementI18n({ messages, onChange }) { change = onChange; assert.equal(messages.en.title, 'Kits'); assert.equal(messages.en.kits, 'Kits'); assert.equal(messages['zh-Hans'].title, 'Kits'); assert.equal(messages['zh-Hans'].kits, 'Kits'); return { t: (key, values) => createLocalization().translate(messages, locale, key, values) }; } };
  vm.runInNewContext(script, { document, window, fetch, EventSource });
  await new Promise(setImmediate);
  assert.deepEqual(calls.map(call => call.url), ['api/state']);
  assert.equal(nodes.updates.hidden, false);
  nodes['github-token'].value = 'fixture-token';
  await nodes['check-updates'].onclick();
  assert.equal(nodes['github-token'].value, '');
  assert.equal(nodes['update-result'].textContent, 'Updates available: 1 · Kits available to install: 1');
  assert.equal(JSON.parse(calls[1].options.body).token, 'fixture-token');
  const updateCell = nodes.features.children[0].children[3], remote = updateCell.children[2];
  assert.equal(remote.hidden, false); assert.equal(remote.disabled, false);
  assert.equal(remote.attributes['aria-label'], 'Prepare update for footer');
  const directory = updateCell.children[3], enabled = nodes.features.children[0].children[2].children[0];
  directory.value = 'C:/keep'; enabled.checked = false; nodes['github-token'].value = 'keep-token';
  locale = 'zh-Hans'; change();
  assert.equal(remote.attributes['aria-label'], '准备更新 footer');
  assert.equal(nodes['update-result'].textContent, '可用更新：1 · 可安装插件：1');
  assert.equal(nodes.status.textContent, '宿主：正在运行 · PID 10');
  assert.equal(directory.value, 'C:/keep'); assert.equal(enabled.checked, false); assert.equal(nodes['github-token'].value, 'keep-token');
  assert.deepEqual(calls.map(call => call.url), ['api/state', 'api/check-updates']);
  await remote.onclick();
  assert.equal(JSON.parse(calls[2].options.body).id, 'footer');
  assert.equal(remote.disabled, true);
  assert.equal(nodes.catalog.hidden, false);
  const install = nodes['available-kits'].children[0].children[2].children[0];
  assert.equal(install.attributes['aria-label'], '准备安装 extra');
  await install.onclick();
  assert.equal(JSON.parse(calls[3].options.body).id, 'extra');
  assert.equal(nodes.catalog.hidden, true);
  assert.equal(nodes.features.children[1].children[1].textContent, '未安装');
  assert.equal(nodes.features.children[1].children[2].children[0].checked, true);
  nodes['install-directory'].value = 'C:/trusted/kit'; await nodes['prepare-install'].onclick();
  assert.equal(JSON.parse(calls[4].options.body).directory, 'C:/trusted/kit');
});
