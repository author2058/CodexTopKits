import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureHost, featureModule } from 'codex-toolkit-core/features';
import footer from 'codex-toolkit-core/kits/footer';
import weekly, { createWeeklyUsage } from '../kits/weekly-usage/index.mjs';
import scheduled, { createScheduledReset } from '../kits/scheduled-reset-marker/index.mjs';
import { installUsageToolbar } from '../src/toolbar.mjs';
import { weeklyProgress } from '../src/weekly-progress.mjs';
import { featureDom } from './feature-dom.mjs';

const packed = async definition => (await import('data:text/javascript;base64,' + Buffer.from(featureModule(definition), 'utf8').toString('base64'))).default;
const state = locale => ({ languagePreference: { mode: 'fixed', locale } });

test('packed usage and reset Kits localize in place without changing data or subscriptions', async () => {
  const usage = await packed(weekly), reset = await packed(scheduled);
  assert.equal(usage.manifest.version, '0.1.6'); assert.equal(reset.manifest.version, '0.1.7');
  assert.equal(usage.manifest.minimumCoreVersion, '0.3.39'); assert.equal(reset.manifest.minimumCoreVersion, '0.3.39');
  const fixture = featureDom({ withQuery: false }), { document, listeners, intervals, query } = fixture;
  const resetAt = query.state.data.rate_limit.primary_window.reset_at * 1000;
  const runtimeState = { hardReset: { forecast: { scheduledAt: resetAt - 86400000 }, error: null } };
  const host = createFeatureHost([footer, usage, reset], { document, hostState: state('en'), runtimeState, serviceVersionChecks: true });
  await host.start('scheduled-reset-marker');
  const bar = document.getElementById('codex-usage-toolbar'), label = bar.querySelector('.codex-usage-label');
  assert.equal(label.textContent, 'Waiting for native usage…');
  host.setHostState(state('zh-Hans')); assert.equal(label.textContent, '等待原生用量…');
  fixture.showQuery(); host.refresh();
  const usageBar = bar.querySelector('[data-kind="usage"]'), timeBar = bar.querySelector('[data-kind="time"]'), link = bar.querySelector('.codex-usage-hard-reset');
  const date = new Date(resetAt), hhmm = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  assert.equal(label.textContent, `60% · ${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`);
  assert.match(link.title, /数据来自 Codex Resets · 点击查看来源$/);
  assert.equal(link.href, 'https://codex-resets.com'); assert.equal(listeners.size, 1); assert.equal(intervals.size, 1);
  const error = 'Native diagnostic 原文';
  host.setRuntimeState({ hardReset: { ...runtimeState.hardReset, error: { message: error } } });
  assert.ok(link.title.endsWith('查询异常，保留上次预计时间：' + error));
  const width = usageBar.style.getPropertyValue('--cdt-weekly-progress-width'), timeWidth = timeBar.style.getPropertyValue('--cdt-weekly-progress-width');
  const left = link.style.getPropertyValue('left'), timer = [...intervals.keys()][0];
  host.setHostState(state('en'));
  assert.equal(bar.querySelector('.codex-usage-label'), label); assert.equal(bar.querySelector('[data-kind="usage"]'), usageBar);
  assert.equal(bar.querySelector('[data-kind="time"]'), timeBar); assert.equal(bar.querySelector('.codex-usage-hard-reset'), link);
  assert.equal(label.textContent, `60% · ${date.getMonth() + 1}/${date.getDate()} ${hhmm}`);
  assert.ok(link.title.endsWith('Query failed; keeping the last estimate: ' + error));
  assert.equal(usageBar.style.getPropertyValue('--cdt-weekly-progress-width'), width); assert.equal(timeBar.style.getPropertyValue('--cdt-weekly-progress-width'), timeWidth);
  assert.equal(link.style.getPropertyValue('left'), left); assert.deepEqual([...intervals.keys()], [timer]); assert.equal(listeners.size, 1);
  let writes = 0; const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(label), 'textContent');
  Object.defineProperty(label, 'textContent', { get() { return descriptor.get.call(this); }, set(value) { writes++; descriptor.set.call(this, value); } });
  const title = link.title; host.setHostState(state('en')); assert.equal(writes, 0); assert.equal(link.title, title);
  host.setHostState(state('zh-Hans')); assert.equal(writes, 1); assert.ok(link.title.endsWith('查询异常，保留上次预计时间：' + error));
  await host.close(); assert.equal(listeners.size, 0); assert.equal(intervals.size, 0); assert.equal(fixture.observers.size, 0); assert.equal(fixture.events.size, 0);
});

test('legacy toolbar without locale input retains its original labels and tooltip', () => {
  const { document, query } = featureDom(), container = document.createElement('div'), resetAt = query.state.data.rate_limit.primary_window.reset_at * 1000;
  const toolbar = installUsageToolbar(document, () => null, weeklyProgress, () => ({ element: container, left: container, setHostState() {}, release() {} }), () => ({ leftPercent: 20 }));
  toolbar.refresh(); assert.equal(container.querySelector('.codex-usage-label').textContent, '等待原生用量…');
  toolbar.update({ updatedAt: 1, weekly: { resetAt, remainingPercent: 60 } });
  toolbar.setHardReset({ forecast: { scheduledAt: resetAt - 86400000 }, error: null });
  assert.match(container.querySelector('.codex-usage-label').textContent, /^60% · \d+月\d+日 \d{2}:\d{2}$/);
  assert.match(container.querySelector('.codex-usage-hard-reset').title, /^预计硬重置：.* · Data from Codex Resets · 点击查看来源$/);
  toolbar.cleanup();
});

test('both Kits reject missing localization and release locale subscriptions on startup failure', () => {
  let effects = 0;
  assert.throws(() => createWeeklyUsage({ document: { createElement() { effects++; } } }, {}), /requires Core 0\.3\.39/);
  assert.throws(() => createScheduledReset({ document: { createElement() { effects++; } } }, {}), /requires Core 0\.3\.39/);
  assert.equal(effects, 0);
  const { document, events } = featureDom(), callbacks = new Set(), original = new Error('subscription failed');
  const i18n = { t: (messages, key) => messages.en[key], onChange(callback) { callbacks.add(callback); return () => callbacks.delete(callback); } };
  assert.throws(() => createWeeklyUsage({ document, i18n, onDomChange() { throw original; } }, weekly.helpers), error => error === original);
  assert.equal(callbacks.size, 0); assert.equal(events.size, 0); assert.equal(document.head.children.length, 0);
  assert.throws(() => createScheduledReset({ document, i18n, dependencies: { 'weekly-usage': { renderHardResetTitle() {} } }, onRuntimeState() { throw original; } }, scheduled.helpers), error => error === original);
  assert.equal(callbacks.size, 0); assert.equal(document.head.children.length, 0);
});
