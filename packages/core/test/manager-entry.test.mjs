import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureHost, featurePayload } from '../src/features.mjs';
import footer from '../kits/footer/index.mjs';
import manager from '../kits/manager-entry/index.mjs';
import { featureDom } from './support/feature-dom.mjs';
import vm from 'node:vm';

test('manager entry has an independent lifecycle and exact health count while the footer remains', async () => {
  const { document } = featureDom(), state = { managerUrl: 'http://127.0.0.1:1234/', health: { plugins: [] } };
  const host = createFeatureHost([footer, manager], { document, hostState: state });
  await host.start('footer'); const bar = document.getElementById('codex-usage-toolbar'); assert.equal(bar.children[2].children.length, 0);
  await host.start('manager-entry'); const button = bar.querySelector('.codex-usage-settings');
  assert.equal(button.textContent, '⚙'); assert.equal(button.getAttribute('href'), state.managerUrl);
  host.setHostState({ ...state, languagePreference: { mode: 'fixed', locale: 'zh-Hans' } });
  assert.equal(button.getAttribute('title'), '打开工具设置');
  host.setHostState({ ...state, languagePreference: { mode: 'fixed', locale: 'en' }, health: { plugins: [{ ok: false, issueCount: 12 }] } });
  assert.equal(button.getAttribute('title'), '12 issues found; open details');
  assert.equal(bar.querySelector('.codex-usage-settings'), button);
  host.setHostState({ ...state, health: { plugins: [{ ok: false, issueCount: 12 }] } });
  assert.equal(button.textContent, '12'); assert.equal(button.getAttribute('data-codex-health'), 'error');
  host.setHostState(state); assert.equal(button.textContent, '⚙');
  await host.stop('manager-entry'); assert.equal(bar.children[2].children.length, 0); assert.equal(document.getElementById('codex-usage-toolbar'), bar);
  assert.ok(!document.head.children[0].textContent.includes('.codex-usage-settings'));
  await host.start('manager-entry'); await host.close(); assert.equal(document.head.children.length, 0);
});

test('serialized manager entry runs with its declared footer only', async () => {
  const { document } = featureDom(), window = document.defaultView;
  await vm.runInNewContext(featurePayload([manager, footer]), { document, window });
  const button = document.getElementById('codex-usage-toolbar').children[2].children[0];
  window.__CODEXTOPKITS_FEATURE_HOST__.setHostState({ languagePreference: { mode: 'fixed', locale: 'zh-Hans' }, health: { plugins: [{ ok: false, issueCount: 2 }] } });
  assert.equal(button.getAttribute('title'), '发现 2 项问题，点击查看详情');
  await window.__CODEXTOPKITS_FEATURE_HOST__.close();
});
