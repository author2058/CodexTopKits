import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureHost, featureModule } from 'codex-toolkit-core/features';
import footer from 'codex-toolkit-core/kits/footer';
import cloud from '../kits/cloud-mark-read/index.mjs';
import { createCloudMarkRead } from '../src/cloud-read-feature.mjs';
import { featureDom } from './feature-dom.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('packed cloud control switches language without changing state or native behavior', async () => {
  const source = featureModule(cloud);
  const { default: packed } = await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'));
  assert.equal(packed.manifest.version, '0.1.3');
  assert.equal(packed.manifest.minimumCoreVersion, '0.3.39');
  const fixture = featureDom(), { document, observers } = fixture;
  document.documentElement.setAttribute('lang', 'en-US'); document.defaultView.navigator = { language: 'zh-CN' };
  const listeners = new Set(), marked = [], ids = ['cloud-one', 'cloud-two'];
  let resolveLoad, resolveMark, loads = 0;
  const pendingLoad = new Promise(resolve => { resolveLoad = resolve; });
  const pendingMark = new Promise(resolve => { resolveMark = resolve; });
  const readState = { read: () => ({ durable: ids }), isReady: () => true, subscribe({ listener }) { listeners.add(listener); return () => listeners.delete(listener); } };
  const native = { readState, badgeStore: { getSnapshot: () => ids.length, subscribe: () => () => {} }, markRead(id) { marked.push(id); return pendingMark; } };
  packed.helpers.createNativeAssetReader = () => ({});
  packed.helpers.loadNativeConversationRpc = async () => ({});
  packed.helpers.loadNativeCloudUnread = () => { loads++; return pendingLoad; };
  const host = createFeatureHost([footer, packed], { document, hostState: { languagePreference: { mode: 'auto' }, systemLanguage: 'zh-CN' } });
  await host.start('cloud-mark-read'); await tick();
  const button = document.getElementById('codex-usage-toolbar').querySelector('.cdtk-clear-cloud-unread');
  assert.equal(button.getAttribute('title'), 'Clear cloud unread'); assert.equal(button.getAttribute('aria-label'), 'Clear cloud unread');
  button.click(); assert.equal(host.snapshot().find(item => item.id === 'cloud-mark-read').error.message, 'Cloud unread is not connected yet. Check the settings page for details.');
  host.setHostState({ languagePreference: { mode: 'fixed', locale: 'zh-Hans' }, systemLanguage: 'en-US' });
  assert.equal(button.getAttribute('title'), '清理云端未读'); assert.equal(button.getAttribute('aria-label'), '清理云端未读');
  button.click(); assert.equal(host.snapshot().find(item => item.id === 'cloud-mark-read').error.message, '云端未读接口尚未连接，请在设置页查看详情。');
  resolveLoad(native); await tick(); assert.equal(loads, 1); assert.equal(listeners.size, 1);
  button.click(); await tick(); assert.deepEqual(marked, ['cloud-one', 'cloud-two']); assert.equal(button.disabled, true);
  const svg = button.innerHTML;
  host.setHostState({ languagePreference: { mode: 'fixed', locale: 'en' }, systemLanguage: 'zh-CN' });
  assert.equal(document.getElementById('codex-usage-toolbar').querySelector('.cdtk-clear-cloud-unread'), button);
  assert.equal(button.getAttribute('title'), 'Clear cloud unread'); assert.equal(button.getAttribute('aria-label'), 'Clear cloud unread');
  assert.equal(button.disabled, true); assert.equal(button.innerHTML, svg); assert.equal(loads, 1); assert.equal(listeners.size, 1);
  resolveMark(); await tick(); assert.equal(button.disabled, false); assert.deepEqual(marked, ['cloud-one', 'cloud-two']);
  await host.stop('cloud-mark-read'); assert.equal(listeners.size, 0); assert.equal(observers.size, 1);
  await host.close(); assert.equal(observers.size, 0); assert.equal(fixture.intervals.size, 0);
});

test('cloud control checks localization before side effects and releases subscriptions on startup failure', () => {
  let effects = 0;
  assert.throws(() => createCloudMarkRead({ document: { createElement() { effects++; } } }, {}), /requires Core 0\.3\.39/);
  assert.equal(effects, 0);
  const { document } = featureDom(), callbacks = new Set(), original = new Error('DOM subscription failed');
  const i18n = { t: (messages, key) => messages.en[key], onChange(callback) { callbacks.add(callback); return () => callbacks.delete(callback); } };
  assert.throws(() => createCloudMarkRead({ document, i18n, onDomChange() { throw original; } }, { cloudReadCss: () => '' }), error => error === original);
  assert.equal(callbacks.size, 0); assert.equal(document.head.children.length, 0);
});

test('cloud control preserves native diagnostics', async () => {
  const { document } = featureDom(), error = new Error('Native diagnostic'), reports = [];
  const definition = { ...cloud, helpers: { ...cloud.helpers, createNativeAssetReader: () => ({}), loadNativeConversationRpc: async () => { throw error; } } };
  const host = createFeatureHost([footer, definition], { document, onChange: state => reports.push(state) });
  await host.start('cloud-mark-read'); await tick();
  const issue = reports.at(-1).find(item => item.id === 'cloud-mark-read').error;
  assert.equal(issue.source, 'native'); assert.equal(issue.message, error.message); assert.equal(issue.stack, error.stack);
  await host.close();
});
