import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createFeatureHost, featurePayload } from 'codex-toolkit-core/features';
import footer from 'codex-toolkit-core/kits/footer';
import manager from 'codex-toolkit-core/kits/manager-entry';
import tabs from '../kits/window-tabs/index.mjs';
import moon from '../kits/auto-sleep/index.mjs';
import cloud from '../kits/cloud-mark-read/index.mjs';
import { featureDom } from './feature-dom.mjs';
import { installWindowsRenderer } from '../src/renderer.mjs';
import { updateIndicatorCss } from '../src/update-indicator.mjs';
import { windowTabsCss, autoSleepCss } from '../src/footer-styles.mjs';
import { windowsPayload } from '../src/payload.mjs';

test('standalone and aggregate footer paths share theme-aware colors', () => {
  const payload = windowsPayload({ epoch: 'colors' });
  assert.ok(payload.includes(windowTabsCss.toString()));
  assert.ok(payload.includes(autoSleepCss.toString()));
  assert.match(windowTabsCss(), /light-dark\(#ffffff,#10131b\)/);
  assert.match(windowTabsCss(), /fill:light-dark\(#2563b8,#60a5fa\)/);
  assert.match(autoSleepCss(), /light-dark\(#b91c1c,#ef4444\)/);
  assert.match(updateIndicatorCss(), /light-dark\(#15803d,#22c55e\)/);
});

test('real window tabs and moon have separate lifecycles and dispatch exact target IDs', async () => {
  const { document, intervals } = featureDom(), actions = [];
  const createElement = document.createElement; let markerAtInsertion;
  document.createElement = tag => {
    const node = createElement(tag), insertBefore = node.insertBefore.bind(node);
    node.insertBefore = (child, reference) => {
      if (node.id === 'cdtk-window-switcher' && child.dataset.targetId === 'one') markerAtInsertion = child.id;
      return insertBefore(child, reference);
    };
    return node;
  };
  const state = { targetId: 'one', autoSleep: { enabled: false }, windows: [
    { targetId: 'one', title: 'First window', color: '#112233', status: 'idle', unread: false },
    { targetId: 'three', title: 'The actual third window with a long title to trim', color: '#445566', status: 'active', unread: true },
  ] };
  const host = createFeatureHost([footer, tabs, moon, manager], { document, runtimeState: state, serviceVersionChecks: true, dispatch: action => actions.push(action) });
  await host.start('window-tabs'); const picker = document.getElementById('cdtk-window-switcher'), original = picker.children[1];
  assert.equal(document.getElementById('codex-usage-toolbar').children[2].children.length, 0);
  assert.equal(picker.children.length, 2); assert.equal(original.lastElementChild.dataset.state, 'running');
  assert.equal(markerAtInsertion, 'cdtk-window-one'); assert.equal(picker.children[0].id, 'cdtk-window-one');
  original.click(); assert.deepEqual(actions.pop(), { kind: 'activate', targetId: 'three' });
  assert.ok(original.firstElementChild.textContent.includes('...')); assert.ok(!original.firstElementChild.textContent.endsWith('...'));
  host.setRuntimeState(state); assert.equal(picker.children[1], original);
  await host.start('auto-sleep'); const button = document.getElementById('codex-usage-toolbar').querySelector('.cdtk-auto-sleep');
  assert.ok(!button.id); assert.equal(picker.children[0].id, 'cdtk-window-one');
  button.click(); assert.deepEqual(actions.pop(), { kind: 'sleep-toggle', enabled: true });
  host.setRuntimeState({ ...state, autoSleep: { enabled: true } }); assert.equal(button.getAttribute('aria-pressed'), 'true');
  await host.stop('auto-sleep'); assert.equal(picker.children[0].id, 'cdtk-window-one'); await host.start('auto-sleep');
  const restartedMoon = document.getElementById('codex-usage-toolbar').querySelector('.cdtk-auto-sleep');
  await host.stop('window-tabs'); assert.equal(document.getElementById('cdtk-window-switcher'), undefined); assert.equal(restartedMoon.getAttribute('aria-pressed'), 'true');
  assert.equal(intervals.size, 0); await host.start('manager-entry'); await host.stop('auto-sleep');
  assert.ok(document.getElementById('codex-usage-toolbar').querySelector('.codex-usage-settings'));
  await host.close(); assert.equal(document.getElementById('codex-usage-toolbar'), undefined); assert.equal(document.head.children.length, 0);
});

test('serialized tabs and moon use pushed state and do not install cloud, update or read-aloud controls', async () => {
  const { document } = featureDom(), window = document.defaultView, actions = [];
  window.fixtureBinding = value => actions.push(JSON.parse(value));
  await vm.runInNewContext(featurePayload([footer, tabs, moon], { serviceVersionChecks: true, bindingName: 'fixtureBinding', runtimeState: { targetId: 'one', windows: [], autoSleep: { enabled: false } } }), { document, window });
  document.getElementById('cdtk-window-switcher'); const button = document.getElementById('codex-usage-toolbar').querySelector('.cdtk-auto-sleep');
  button.click(); assert.equal(actions.at(-1).kind, 'sleep-toggle');
  assert.equal(document.querySelector('.cdtk-clear-cloud-unread'), null);
  assert.ok(!featurePayload([footer, tabs, moon]).includes('installReadAloudMenu'));
  await window.__CODEXTOPKITS_FEATURE_HOST__.close();
});

test('the moon preserves a pre-insertion window marker without new tabs and hands it to new tabs', async () => {
  const { document } = featureDom(), createElement = document.createElement; let markerAtInsertion;
  document.createElement = tag => {
    const node = createElement(tag), appendChild = node.appendChild.bind(node);
    node.appendChild = child => { if (child.className === 'cdtk-auto-sleep') markerAtInsertion = child.id; return appendChild(child); };
    return node;
  };
  const state = { targetId: 'one', autoSleep: { enabled: false }, windows: [{ targetId: 'one', title: 'First', color: '#112233', status: 'idle' }] };
  const host = createFeatureHost([footer, tabs, moon], { document, runtimeState: state, serviceVersionChecks: true });
  await host.start('auto-sleep');
  const toolbar = document.getElementById('codex-usage-toolbar'), button = toolbar.querySelector('.cdtk-auto-sleep');
  assert.equal(markerAtInsertion, 'cdtk-window-one'); assert.equal(button.id, 'cdtk-window-one');
  const legacyPicker = document.createElement('div'), legacyTab = document.createElement('button');
  legacyPicker.id = 'cdtk-window-switcher'; legacyTab.dataset.targetId = 'one'; legacyPicker.appendChild(legacyTab); toolbar.children[1].appendChild(legacyPicker);
  host.setRuntimeState(state); assert.equal(button.id, 'cdtk-window-one');
  legacyPicker.remove(); await host.start('window-tabs');
  assert.equal(button.id, ''); assert.equal(document.getElementById('cdtk-window-switcher').children[0].id, 'cdtk-window-one');
  host.setRuntimeState(state); assert.equal(button.id, '');
  await host.close();
});

test('new window tabs reject a footer without flexible slots', () => {
  const olderFooter = { ...footer, manifest: { ...footer.manifest, version: '0.1.2' } };
  assert.throws(() => createFeatureHost([olderFooter, tabs], { document: featureDom().document, serviceVersionChecks: true }), /requires footer@\^0\.1\.3/);
});

test('cloud mark-read clears native cloud IDs and releases its own subscriptions without hiding the button', async () => {
  const { document } = featureDom(), listeners = new Set(), ids = ['cloud-one'], marked = [];
  const readState = { read: () => ({ durable: ids }), isReady: () => true, subscribe({ listener }) { listeners.add(listener); return () => listeners.delete(listener); } };
  const native = { readState, badgeStore: { getSnapshot: () => ids.length, subscribe: () => () => {} }, markRead(id) { marked.push(id); ids.length = 0; for (const listener of listeners) listener(); } };
  const definition = { ...cloud, helpers: { ...cloud.helpers, createNativeAssetReader: () => ({}), loadNativeConversationRpc: async () => ({}), loadNativeCloudUnread: async () => native } };
  const host = createFeatureHost([footer, definition], { document });
  await host.start('cloud-mark-read'); await new Promise(resolve => setImmediate(resolve));
  const button = document.getElementById('codex-usage-toolbar').querySelector('.cdtk-clear-cloud-unread');
  button.click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(marked, ['cloud-one']); assert.equal(button.hidden, undefined); assert.equal(button.disabled, false);
  assert.equal(listeners.size, 1); await host.stop('cloud-mark-read'); assert.equal(listeners.size, 0);
  assert.ok(document.getElementById('codex-usage-toolbar')); await host.close();
});

test('legacy footer handoff keeps read-aloud and update protection without creating duplicate controls or cloud subscriptions', async () => {
  const { document, observers } = featureDom(), window = document.defaultView, reports = []; window.top = window;
  window.__CDTK_WINDOWS_BRIDGE__ = value => reports.push(JSON.parse(value));
  let menus = 0, updates = 0;
  const helpers = {
    acquireFooter: () => assert.fail('Legacy footer must not acquire a lease'),
    createNativeBridgeClient: () => ({ close() {} }), readNativeConversationIdentity: () => null,
    createNativeAssetReader: () => ({}), loadNativeAppServices: async () => ({ appUpdates: { installUpdate() {} } }),
    installReadAloudMenu: () => { menus++; return { refresh() {}, cleanup() {}, status: () => ({}) }; },
    updateIndicatorCss,
    installHostedUpdateControl: () => { updates++; return { ready: Promise.resolve(), refreshButtons() {}, cleanup() {}, status: () => ({}) }; },
    loadNativeConversationRpc: () => assert.fail('Legacy cloud unread must not initialize'),
  };
  installWindowsRenderer(window, { epoch: 'handoff', externalFooter: true }, helpers);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(menus, 1); assert.equal(updates, 1); assert.equal(document.getElementById('codex-usage-toolbar'), undefined);
  assert.ok(!document.head.children[0].textContent.includes('.cdtk-auto-sleep'));
  assert.equal(reports.at(-1).errors.length, 0); window.__CODEX_DESKTOP_TOOLKIT_WINDOWS__.cleanup(); assert.equal(observers.size, 0);
});
