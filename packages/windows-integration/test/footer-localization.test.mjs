import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureHost, featureModule } from 'codex-toolkit-core/features';
import footer from 'codex-toolkit-core/kits/footer';
import tabs from '../kits/window-tabs/index.mjs';
import moon from '../kits/auto-sleep/index.mjs';
import { createWindowTabs, createAutoSleep, installWindowTabs, installAutoSleepButton } from '../src/footer-features.mjs';
import { featureDom } from './feature-dom.mjs';

async function packed(definition) {
  return (await import('data:text/javascript;base64,' + Buffer.from(featureModule(definition), 'utf8').toString('base64'))).default;
}

test('packed footer Kits switch labels in place while retaining window and sleep state', async () => {
  const packedTabs = await packed(tabs), packedMoon = await packed(moon);
  assert.equal(packedTabs.manifest.version, '0.1.9'); assert.equal(packedMoon.manifest.version, '0.1.7');
  assert.equal(packedTabs.manifest.minimumCoreVersion, '0.3.39'); assert.equal(packedMoon.manifest.minimumCoreVersion, '0.3.39');
  const fixture = featureDom(), { document, observers, viewEvents } = fixture, createElement = document.createElement;
  let svgCreations = 0, measurements = 0, attributeWrites = 0;
  document.createElement = tag => {
    const node = createElement(tag), setAttribute = node.setAttribute.bind(node), measure = node.getBoundingClientRect.bind(node);
    node.setAttribute = (key, value) => { attributeWrites++; setAttribute(key, value); };
    node.getBoundingClientRect = () => { measurements++; return measure(); };
    if (tag === 'span') {
      const querySelector = node.querySelector.bind(node);
      node.querySelector = selector => selector === 'svg' ? node.children.find(child => child.tag === 'svg') || null : querySelector(selector);
      Object.defineProperty(node, 'innerHTML', { set(value) {
        this.children = [];
        if (value) { const svg = document.createElement('svg'); svgCreations++; svg.setAttribute('aria-label', value.match(/aria-label="([^"]+)"/)[1]); this.appendChild(svg); }
      } });
    }
    return node;
  };
  document.documentElement.setAttribute('lang', 'en-US');
  const actions = [], state = { targetId: 'window-exact', autoSleep: { enabled: false, error: 'native error: 原样' }, windows: [
    { targetId: 'window-exact', title: '真实会话 Title', color: '#123456', status: 'active', unread: true },
    { targetId: 'other-exact', title: 'Other', color: '#654321', status: 'idle', unread: true },
  ] };
  const host = createFeatureHost([footer, packedTabs, packedMoon], { document, runtimeState: state, serviceVersionChecks: true, dispatch: action => actions.push(action) });
  await host.start('window-tabs'); await host.start('auto-sleep');
  const picker = document.getElementById('cdtk-window-switcher'), tab = picker.children[0], unreadTab = picker.children[1];
  const running = tab.lastElementChild, runningSvg = running.querySelector('svg'), unreadSvg = unreadTab.lastElementChild.querySelector('svg');
  const button = document.getElementById('codex-usage-toolbar').querySelector('.cdtk-auto-sleep');
  const tabHandler = picker.listeners.get('click'), moonHandler = button.listeners.get('click'), measureCount = measurements, svgCount = svgCreations;
  assert.equal(picker.getAttribute('aria-label'), 'Switch Codex windows');
  assert.equal(runningSvg.getAttribute('aria-label'), 'Running'); assert.equal(unreadSvg.getAttribute('aria-label'), 'Unread');
  assert.equal(button.getAttribute('title'), 'Automatic sleep failed: native error: 原样');
  host.setHostState({ languagePreference: { mode: 'fixed', locale: 'zh-Hans' } });
  assert.equal(picker.getAttribute('aria-label'), '切换 Codex 窗口');
  assert.equal(runningSvg.getAttribute('aria-label'), '正在运行'); assert.equal(unreadSvg.getAttribute('aria-label'), '未读');
  assert.equal(button.getAttribute('title'), '自动睡眠失败：native error: 原样');
  assert.equal(button.getAttribute('aria-label'), button.getAttribute('title'));
  assert.equal(picker.children[0], tab); assert.equal(tab.lastElementChild, running); assert.equal(running.querySelector('svg'), runningSvg);
  assert.equal(unreadTab.lastElementChild.querySelector('svg'), unreadSvg); assert.equal(button.listeners.get('click'), moonHandler); assert.equal(picker.listeners.get('click'), tabHandler);
  assert.equal(tab.getAttribute('title'), state.windows[0].title); assert.equal(tab.dataset.targetId, 'window-exact');
  assert.equal(button.getAttribute('aria-pressed'), 'false'); assert.equal(button.getAttribute('data-error'), 'true');
  assert.equal(measurements, measureCount); assert.equal(svgCreations, svgCount);
  const writes = attributeWrites; host.setHostState({ languagePreference: { mode: 'fixed', locale: 'zh-Hans' } }); assert.equal(attributeWrites, writes);
  unreadTab.click(); button.click(); assert.deepEqual(actions, [{ kind: 'activate', targetId: 'other-exact' }, { kind: 'sleep-toggle', enabled: true }]);
  host.setRuntimeState({ ...state, autoSleep: { enabled: true } }); assert.equal(button.getAttribute('title'), '全部会话结束并静置一分钟后睡眠；点击取消');
  host.setHostState({ languagePreference: { mode: 'fixed', locale: 'en' } });
  assert.equal(button.getAttribute('title'), 'Sleep after all conversations finish and remain idle for one minute; click to cancel');
  host.setRuntimeState({ ...state, autoSleep: { enabled: false } }); assert.equal(button.getAttribute('title'), 'Automatic sleep is off; click to enable');
  await host.close(); assert.equal(observers.size, 0); assert.equal(viewEvents.has('resize'), false); assert.equal(fixture.intervals.size, 0); assert.equal(document.head.children.length, 0);
});

test('footer Kits require localization and unsubscribe on startup failure', () => {
  for (const [create, helperName, cssName] of [[createWindowTabs, 'installWindowTabs', 'windowTabsCss'], [createAutoSleep, 'installAutoSleepButton', 'autoSleepCss']]) {
    assert.throws(() => create({}, {}), /requires Core 0\.3\.39/);
    const { document, main } = featureDom(), callbacks = new Set(), error = new Error('runtime subscription failed');
    const i18n = { t: (messages, key) => messages.en[key], onChange(callback) { callbacks.add(callback); return () => callbacks.delete(callback); } };
    const helpers = { [helperName]: helperName === 'installWindowTabs' ? installWindowTabs : installAutoSleepButton, [cssName]: () => '' };
    assert.throws(() => create({ document, i18n, dependencies: { footer: {} }, onDomChange: () => () => {}, onRuntimeState() { throw error; } }, helpers), value => value === error);
    assert.equal(callbacks.size, 0); assert.equal(document.head.children.length, 0);
    main.remove(); let released = 0;
    const instance = create({ document, i18n, dependencies: { footer: {} }, onDomChange: () => () => released++, onRuntimeState: () => () => released++ }, helpers);
    assert.equal(callbacks.size, 1); instance.close(); assert.equal(callbacks.size, 0); assert.equal(released, 2); assert.equal(document.head.children.length, 0);
  }
});

test('legacy direct helpers retain their Chinese labels without localization', () => {
  const { document } = featureDom(), center = document.createElement('div'), right = document.createElement('div');
  const acquire = () => ({ center, right, release() {} }), state = () => ({ autoSleep: { enabled: false }, windows: [] });
  const tabsUi = installWindowTabs(document, acquire, state, () => {}, () => '', '');
  const moonUi = installAutoSleepButton(document, acquire, state, () => {}, '');
  tabsUi.refresh(); moonUi.refresh();
  assert.equal(center.children[0].getAttribute('aria-label'), '切换 Codex 窗口');
  assert.equal(right.children[0].getAttribute('title'), '自动睡眠已关闭，点击开启');
  tabsUi.cleanup(); moonUi.cleanup();
});
