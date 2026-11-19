import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureHost } from 'codex-toolkit-core/features';
import footer from 'codex-toolkit-core/kits/footer';
import weekly from '../kits/weekly-usage/index.mjs';
import scheduled from '../kits/scheduled-reset-marker/index.mjs';
import { featureDom } from './feature-dom.mjs';
import createScheduledResetService from '../src/feature-service.mjs';
import { chatCss } from '../src/styles.mjs';

test('scheduled reset is an independent weekly dependency and removes its line without affecting usage', async () => {
  const { document, query } = featureDom(), resetAt = query.state.data.rate_limit.primary_window.reset_at * 1000;
  const state = { hardReset: { forecast: { scheduledAt: resetAt - 86400000 }, error: null } };
  const host = createFeatureHost([footer, weekly, scheduled], { document, runtimeState: state, serviceVersionChecks: true });
  await host.start('scheduled-reset-marker');
  const bar = document.getElementById('codex-usage-toolbar'), summary = bar.querySelector('.codex-usage-summary');
  assert.ok(summary.querySelector('.codex-usage-hard-reset'));
  host.setRuntimeState({ hardReset: { forecast: null } }); assert.equal(summary.querySelector('.codex-usage-hard-reset'), null);
  host.setRuntimeState(state); await host.stop('scheduled-reset-marker'); assert.equal(summary.querySelector('.codex-usage-hard-reset'), null);
  assert.match(bar.querySelector('.codex-usage-label').textContent, /^60%/); await host.close();
});

test('legacy forecast handoff reuses the existing feed instead of starting a second fetch or timer', async () => {
  let listener, closed = false, notifications = 0, enabled = false;
  const old = { featureState: () => ({ hardReset: { forecast: null } }), onFeatureState(value) { listener = value; return () => { closed = true; }; },
    startFeatureForecast() { enabled = true; }, stopFeatureForecast() { enabled = false; } };
  const service = await createScheduledResetService({ legacyPlugin: 'chat' }, { getPlugin: () => old, notify: async () => notifications++ });
  listener(); await Promise.resolve(); assert.equal(notifications, 1); assert.equal(service.snapshot().hardReset.forecast, null);
  assert.equal(enabled, true); service.close(); assert.equal(closed, true); assert.equal(enabled, false);
  assert.ok(!chatCss(true).includes('#codex-usage-toolbar .codex-usage-summary')); assert.ok(chatCss().includes('#codex-usage-toolbar .codex-usage-summary'));
});
