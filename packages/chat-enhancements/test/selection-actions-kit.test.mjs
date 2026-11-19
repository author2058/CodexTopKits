import test from 'node:test';
import assert from 'node:assert/strict';
import { createKitHost, kitModule } from 'codex-toolkit-core/kits';
import kit from '../kits/selection-actions-delay/index.mjs';
import chatPlugin from '../src/index.mjs';
import { chatCss, selectionActionsCss } from '../src/styles.mjs';
import { featureDom } from './feature-dom.mjs';

test('the packaged selection Kit preserves delay, fade blocking, and cleanup', async () => {
  const source = kitModule(kit);
  const definition = (await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))).default;
  const fixture = featureDom(), { document } = fixture, timers = new Map();
  let nextTimer = 0;
  document.defaultView.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  document.defaultView.clearTimeout = id => timers.delete(id);
  document.getSelection = () => ({ isCollapsed: false, toString: () => 'selected text' });
  const overlay = document.createElement('div'), button = document.createElement('button');
  overlay.isConnected = true; button.textContent = 'Add to chat'; button.closest = () => overlay;
  const nativeQuery = document.querySelectorAll;
  document.querySelectorAll = selector => selector === 'button' ? [button] : nativeQuery(selector);
  const runTimer = delay => { const [id, timer] = [...timers].find(([_id, value]) => value.delay === delay); timers.delete(id); timer.callback(); };
  const host = createKitHost([definition], { document });
  await host.start('selection-actions-delay');
  assert.ok(overlay.classList.contains('codex-selection-actions-delayed'));
  assert.equal(overlay.classList.contains('codex-selection-actions-ready'), false);
  assert.match(document.head.children[0].textContent, /pointer-events:none!important/);
  runTimer(1000); assert.ok(overlay.classList.contains('codex-selection-actions-ready'));
  assert.equal(overlay.classList.contains('codex-selection-actions-interactive'), false);
  runTimer(500); assert.ok(overlay.classList.contains('codex-selection-actions-interactive'));
  fixture.main.remove(); host.refresh();
  assert.equal(document.head.children.length, 0); assert.equal(overlay.classList.contains('codex-selection-actions-delayed'), false);
  assert.equal(overlay.dataset.codexSelectionDelay, undefined); assert.equal(timers.size, 0);
  fixture.root.append(fixture.main); host.refresh(); assert.equal(timers.size, 1);
  await host.close(); assert.equal(timers.size, 0); assert.equal(fixture.observers.size, 0); assert.equal(fixture.events.size, 0);
});

test('the legacy aggregate can hand off just this Kit without changing other styles', () => {
  assert.equal(chatCss(false, ['selection-actions-delay']), chatCss().replace(selectionActionsCss(), ''));
  assert.doesNotThrow(() => chatPlugin({ externalKits: ['selection-actions-delay'] }));
});
