import test from 'node:test';
import assert from 'node:assert/strict';
import { kitModule } from 'codex-toolkit-core/kits';
import speed from '../kits/output-speed/index.mjs';
import timer from '../kits/composer-timer/index.mjs';
import live from '../kits/live-model-output/index.mjs';
import { featureDom } from './feature-dom.mjs';
import { installSpeedUi } from '../src/speed-ui.mjs';
import { installLiveOutput } from '../src/live-output.mjs';
import { installComposerUi } from '../src/composer-ui.mjs';

const packed = async kit => (await import('data:text/javascript;base64,' + Buffer.from(kitModule(kit), 'utf8').toString('base64'))).default;
function locale() {
  const listeners = new Set();
  return { locale: 'en', listeners, t(messages, key) { return messages[this.locale][key]; },
    onChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    change(value) { if (this.locale !== value) { this.locale = value; for (const callback of listeners) callback(); } } };
}

test('serialized Kits supply localized text and release one subscription on close and startup failure', async () => {
  for (const original of [speed, timer, live]) {
    const kit = await packed(original), fixture = featureDom(), { document } = fixture, i18n = locale();
    assert.equal(kit.manifest.minimumCoreVersion, '0.3.39');
    const events = new Map(); document.defaultView.addEventListener = (name, fn) => events.set(name, fn);
    document.defaultView.removeEventListener = name => events.delete(name);
    let labels, options, textUpdates = 0, closed = 0, timerListeners = new Set();
    const ui = { refresh() {}, update() {}, renderText() { textUpdates++; }, ready() {}, receive() {}, snapshot() { return {}; }, cleanup() { closed++; } };
    const helpers = { ...kit.helpers, readNativeConversationIdentity: () => null, createOutputSpeedTracker: () => ({ snapshot: () => ({}) }),
      installSpeedUi: (...args) => { labels = args[5]; return ui; }, installComposerUi: (_doc, value) => { options = value; return ui; },
      installLiveOutput: (_doc, _append, _snapshot, value) => { labels = value; return ui; },
      createNativeAssetReader: () => ({}), loadNativeConversationRpc: async () => null, loadNativeDurationFormatter: async () => null };
    const context = { document, i18n, serviceVersionChecks: true, onDomChange: () => () => {}, dispatch() {}, reportError() {},
      dependencies: { 'composer-timer': { onChange(fn) { timerListeners.add(fn); return () => timerListeners.delete(fn); } } } };
    const instance = kit.create(context, helpers);
    assert.equal(i18n.listeners.size, 1);
    if (labels) assert.match(labels().title, /(?:speed|model output)/i);
    if (options) assert.equal(options.getLocale(), 'en');
    i18n.change('zh-Hans'); assert.equal(textUpdates, 1);
    if (labels) assert.match(labels().title, /(?:生成速度|模型输出)/);
    if (options) assert.equal(options.getLocale(), 'zh-Hans');
    i18n.change('zh-Hans'); assert.equal(textUpdates, 1);
    instance.close(); assert.equal(i18n.listeners.size, 0); assert.equal(timerListeners.size, 0); assert.equal(closed, 1);
    assert.throws(() => kit.create({ ...context, onDomChange() { throw new Error('startup'); } }, helpers), /startup/);
    assert.equal(i18n.listeners.size, 0);
  }
});

test('speed locale changes reuse existing values and node without layout reads', () => {
  const fixture = featureDom(), { document } = fixture, view = document.defaultView;
  let frame, reads = 0, scans = 0, language = 'en';
  view.requestAnimationFrame = callback => { frame = callback; return 1; }; view.cancelAnimationFrame = () => {};
  view.addEventListener = view.removeEventListener = () => {}; view.innerWidth = 1000; view.innerHeight = 800;
  view.ResizeObserver = class { observe() {} disconnect() {} }; view.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  const rect = () => { reads++; return { width: 500, height: 500, left: 20, right: 520, top: 20, bottom: 520 }; };
  const viewport = { parentElement: document.body, closest: () => null, getAttribute: () => null, getBoundingClientRect: rect,
    querySelectorAll: () => [], querySelector: selector => selector.includes('conversation') ? viewport : null };
  document.querySelectorAll = selector => { scans++; return selector.startsWith('[data-app-action') ? [viewport] : []; };
  const tracker = { read: () => ({ generationRate: 12.34, endToEndRate: 8.9, ttftMs: 1200, measurementPending: true }) };
  const labels = () => language === 'en' ? { generation: 'Generation', endToEnd: 'End-to-end', first: 'First response', title: 'English' }
    : { generation: '生成', endToEnd: '端到端', first: '首响', title: '中文' };
  const ui = installSpeedUi(document, tracker, () => 'thread', assert.fail, () => {}, labels); frame();
  const node = document.body.children.at(-1), before = [reads, scans];
  assert.equal(node.textContent, 'Generation 12.3 tok/s · End-to-end 8.9 tok/s · First response 1.2 s...');
  language = 'zh-Hans'; ui.renderText();
  assert.equal(node.textContent, '生成 12.3 tok/s · 端到端 8.9 tok/s · 首响 1.2 s...'); assert.equal(node.title, '中文');
  let writes = 0; const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'textContent');
  Object.defineProperty(node, 'textContent', { get() { return descriptor.get.call(this); }, set(value) { writes++; descriptor.set.call(this, value); } });
  ui.renderText(); assert.equal(writes, 0);
  assert.deepEqual([reads, scans], before); assert.equal(document.body.children.at(-1), node); ui.cleanup();
  const legacy = installSpeedUi(document, tracker, () => 'thread', assert.fail); frame();
  assert.equal(document.body.children.at(-1).textContent, '生成 12.3 tok/s · 端到端 8.9 tok/s · 首响 1.2 s...'); legacy.cleanup();
});

test('live output locale changes preserve overlay and scroll without scanning or altering transcript', () => {
  const fixture = featureDom(), { document } = fixture, view = document.defaultView;
  let frame, scans = 0, language = 'en';
  view.requestAnimationFrame = callback => { frame = callback; return 1; }; view.cancelAnimationFrame = () => {};
  const host = document.createElement('div'), bar = document.createElement('div'); host.append(bar); bar.dataset.cdtLiveThreadId = 'thread';
  host.querySelector = () => host.children.find(node => node.className === 'codex-live-output-overlay') || null;
  document.querySelectorAll = selector => { scans++; return selector.startsWith('.codex-composer') ? [bar] : host.children.filter(node => node.className === 'codex-live-output-overlay'); };
  const labels = () => language === 'en' ? { title: 'Show output', output: 'Model output' } : { title: '显示输出', output: '模型输出' };
  const ui = installLiveOutput(document, () => false, null, labels); frame();
  const overlay = host.children[1]; overlay.scrollTop = 17; const before = scans;
  assert.equal(bar.title, 'Show output'); assert.equal(bar.getAttribute('aria-label'), 'Show output');
  language = 'zh-Hans'; ui.renderText();
  assert.equal(bar.title, '显示输出'); assert.equal(overlay.getAttribute('aria-label'), '模型输出');
  let writes = 0; const setBar = bar.setAttribute.bind(bar), setOverlay = overlay.setAttribute.bind(overlay);
  bar.setAttribute = (...args) => { writes++; setBar(...args); }; overlay.setAttribute = (...args) => { writes++; setOverlay(...args); };
  ui.renderText(); assert.equal(writes, 0);
  assert.equal(host.children[1], overlay); assert.equal(overlay.scrollTop, 17); assert.equal(scans, before);
  ui.cleanup(); assert.equal(bar.getAttribute('aria-label'), null);
  const legacy = installLiveOutput(document, () => false); frame();
  assert.equal(bar.title, '点击展开或关闭本线程模型输出（最新50行）'); assert.equal(bar.getAttribute('aria-label'), null);
  assert.equal(host.children[1].getAttribute('aria-label'), '本线程模型输出，最新50行'); legacy.cleanup();
});

test('composer locale changes format the same elapsed time without rescanning or replacing the bar', () => {
  const { document } = featureDom(), view = document.defaultView;
  let frame, scans = 0, language = 'en'; const calls = [];
  view.requestAnimationFrame = callback => { frame = callback; return 1; }; view.cancelAnimationFrame = () => {};
  const host = document.createElement('div'), surface = document.createElement('div'), composer = document.createElement('div');
  composer.querySelector = selector => selector.startsWith('[role=') ? surface : null;
  composer.closest = selector => selector.startsWith('[data-thread') ? host : null;
  composer.getClientRects = () => [1]; host.closest = () => null;
  document.querySelectorAll = () => { scans++; return [composer]; };
  const options = { getClient: () => ({}), getRpc: () => null, currentThread: () => 'thread', getLocale: () => language,
    getFormatter: () => (elapsed, settings) => { calls.push({ elapsed, ...settings }); return settings.locale + ':' + elapsed; },
    onError: assert.fail, onDiagnostic() {}, changed() {} };
  const helpers = { nativeComposerTiming: () => ({ turnId: 'turn', active: false, elapsedMs: 1234 }),
    createRpcComposerTiming: () => ({ read: () => null, cleanup() {}, status() {}, ready() {}, receive() {} }),
    nativeWorkedTiming: () => null, composerIsWorking: () => false };
  const ui = installComposerUi(document, options, helpers); frame(); const bar = host.children[0], before = scans;
  assert.equal(bar.textContent, 'en:1234'); language = 'zh-Hans'; ui.renderText();
  assert.equal(bar.textContent, 'zh-Hans:1234'); assert.equal(host.children[0], bar); assert.equal(scans, before);
  assert.deepEqual(calls.map(({ elapsed, locale, underOneSecond, trimZeroUnits }) => [elapsed, locale, underOneSecond, trimZeroUnits]),
    [[1234, 'en', 'zero', true], [1234, 'zh-Hans', 'zero', true]]);
  ui.cleanup(); assert.equal(host.children.length, 0);
  document.documentElement.lang = 'legacy-language'; delete options.getLocale;
  const legacy = installComposerUi(document, options, helpers); frame();
  assert.equal(host.children[0].textContent, 'legacy-language:1234'); legacy.cleanup();
});
