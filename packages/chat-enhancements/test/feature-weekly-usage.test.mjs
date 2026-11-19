import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createFeatureHost, featurePayload, featureModule } from 'codex-toolkit-core/features';
import footer from 'codex-toolkit-core/kits/footer';
import weekly from '../kits/weekly-usage/index.mjs';
import { featureDom } from './feature-dom.mjs';

test('weekly usage uses the native cache and releases only its own footer resources', async () => {
  const fixture = featureDom(), { document, intervals, listeners, observers, events } = fixture;
  const tabs = { manifest: { id: 'test-window-tabs', version: '0.1.0', entry: 'index.mjs', coreApiVersion: 1, dependencies: { footer: '^0.1.1' } }, create({ dependencies }) {
    const lease = dependencies.footer.acquire('test-window-tabs'), button = document.createElement('button');
    button.textContent = 'Existing tab'; lease.center.appendChild(button);
    return { close() { button.remove(); lease.release(); } };
  } };
  const host = createFeatureHost([footer, weekly, tabs], { document });
  await host.start('footer');
  const bar = document.getElementById('codex-usage-toolbar');
  assert.equal(bar.children[2].children.length, 0);
  assert.equal(intervals.size, 0); assert.equal(listeners.size, 0);
  assert.equal(bar.querySelector('.codex-usage-summary'), null);
  await host.start('test-window-tabs'); await host.start('weekly-usage');
  assert.equal(document.getElementById('codex-usage-toolbar'), bar);
  assert.match(bar.querySelector('.codex-usage-label').textContent, /^60% · /);
  assert.equal(bar.getAttribute('data-codex-usage-state'), 'ready');
  assert.equal(bar.querySelector('[data-kind="usage"]').style.getPropertyValue('--cdtk-weekly-days'), '5');
  assert.equal(listeners.size, 1); assert.equal(observers.size, 2); // Body changes and Core's shared language observer.
  assert.deepEqual([...intervals.values()].map(value => value.delay), [60000]);
  fixture.query.state.data.rate_limit.primary_window.used_percent = 41; fixture.query.state.dataUpdatedAt++;
  fixture.emitQuery(); assert.match(bar.querySelector('.codex-usage-label').textContent, /^59% · /);
  document.hidden = true; events.get('visibilitychange')(); assert.equal(intervals.size, 0);
  document.hidden = false; events.get('visibilitychange')(); assert.equal(intervals.size, 1);
  await assert.rejects(host.stop('footer'), /required by/);
  await host.stop('weekly-usage');
  assert.equal(bar.getAttribute('data-codex-usage-state'), null);
  assert.equal(bar.querySelector('.codex-usage-summary'), null); assert.equal(listeners.size, 0); assert.equal(intervals.size, 0); assert.equal(events.size, 0);
  assert.equal(bar.children[1].textContent, 'Existing tab');
  assert.equal(document.getElementById('codex-usage-toolbar'), bar);
  assert.equal(document.head.children.length, 1); assert.ok(document.documentElement.classList.contains('codex-usage-toolbar-active'));
  await host.start('weekly-usage'); assert.equal(listeners.size, 1); assert.equal(intervals.size, 1);
  await host.close();
  assert.equal(document.getElementById('codex-usage-toolbar'), undefined); assert.equal(document.head.children.length, 0);
  assert.equal(listeners.size, 0); assert.equal(intervals.size, 0); assert.equal(observers.size, 0);
  assert.equal(fixture.root.children[0], fixture.main);
});

test('late native usage discovery and page mounting are event-driven without self-refresh', async () => {
  const fixture = featureDom({ withQuery: false }), { document, observers, listeners } = fixture;
  let refreshes = 0;
  const probe = { manifest: { id: 'test-probe', version: '0.1.0', entry: 'index.mjs', coreApiVersion: 1, dependencies: {} },
    create({ onDomChange }) { const unsubscribe = onDomChange(() => refreshes++); return { close: unsubscribe }; } };
  const host = createFeatureHost([footer, weekly, probe], { document });
  await host.start('weekly-usage'); await host.start('test-probe');
  assert.equal(listeners.size, 0); assert.equal(observers.size, 2);
  const bar = document.getElementById('codex-usage-toolbar');
  fixture.emitDom([{ target: document.body, addedNodes: [bar], removedNodes: [] }]);
  await Promise.resolve(); assert.equal(refreshes, 0);
  fixture.showQuery(); fixture.emitDom([{ target: fixture.main, addedNodes: [], removedNodes: [] }]);
  await Promise.resolve(); assert.equal(refreshes, 1); assert.equal(listeners.size, 1);
  assert.match(bar.querySelector('.codex-usage-label').textContent, /^60% · /);
  fixture.main.remove(); host.refresh();
  assert.equal(document.getElementById('codex-usage-toolbar'), undefined); assert.equal(fixture.intervals.size, 0);
  fixture.root.append(fixture.main); host.refresh();
  assert.match(document.getElementById('codex-usage-toolbar').querySelector('.codex-usage-label').textContent, /^60% · /);
  assert.equal(listeners.size, 1);
  await host.close();
});

test('serialized independent feature artifacts run without the aggregate chat payload', async () => {
  const definitions = [];
  for (const definition of [footer, weekly]) {
    const source = featureModule(definition);
    assert.ok(!source.includes('installChatRenderer')); assert.ok(!source.includes('installComposerTimer'));
    definitions.push((await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))).default);
  }
  const { document, listeners, intervals } = featureDom();
  const window = document.defaultView, payload = featurePayload(definitions);
  const snapshot = await vm.runInNewContext(payload, { window, document });
  assert.deepEqual(Array.from(snapshot, item => item.id), ['footer', 'weekly-usage']);
  assert.ok(snapshot.every(item => item.state === 'running'));
  assert.match(document.getElementById('codex-usage-toolbar').querySelector('.codex-usage-label').textContent, /^60% · /);
  await assert.rejects(vm.runInNewContext(payload, { window, document }), /already owns/);
  await window.__CODEXTOPKITS_FEATURE_HOST__.close();
  assert.equal(listeners.size, 0); assert.equal(intervals.size, 0);
});
