import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKitHost, kitModule } from 'codex-toolkit-core/kits';
import kitRuntime from 'codex-toolkit-core/kit-runtime';
import kit from '../kits/rich-paste-boundary/index.mjs';
import createChatDiagnosticService from '../src/diagnostic-service.mjs';
import { featureDom } from './feature-dom.mjs';

test('packaged rich paste Kit keeps clipboard content out of diagnostics and cleans up', async () => {
  const source = kitModule(kit), definition = (await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))).default;
  const fixture = featureDom(), { document } = fixture, actions = [];
  const host = createKitHost([definition], { document, serviceVersionChecks: true, dispatch: action => actions.push(action) });
  await host.start('rich-paste-boundary');
  const original = 'fixture-clipboard-text', html = '<b>' + original + '</b>';
  const clipboardData = { files: [{}], items: [], getData: type => type === 'text/html' ? html : original };
  fixture.events.get('paste')({ target: { closest: () => ({}) }, clipboardData });
  assert.deepEqual(actions[0], { kind: 'chat-diagnostic', feature: 'paste', record: {
    reason: 'files-present', applied: false, plainLength: original.length, htmlLength: html.length, removedLeading: 0, removedTrailing: 0,
  } });
  assert.ok(!JSON.stringify(actions).includes(original));
  fixture.main.remove(); host.refresh(); assert.equal(fixture.events.has('paste'), false);
  fixture.root.append(fixture.main); host.refresh(); assert.equal(fixture.events.has('paste'), true);
  await host.close(); assert.equal(fixture.events.size, 0); assert.equal(fixture.observers.size, 0);
});

test('diagnostics reuse the existing event shape and cannot write clipboard fields', async () => {
  const logs = [], service = await createChatDiagnosticService({}, { log: async value => logs.push(value) });
  const record = { reason: 'ready', applied: true, plainLength: 5, htmlLength: 12, removedLeading: 1, removedTrailing: 1, clipboard: 'must-not-be-logged' };
  assert.equal(await service.receive('window-one', { kind: 'chat-diagnostic', feature: 'paste', record }), true);
  assert.deepEqual(logs, [{ event: 'chat-diagnostic', targetId: 'window-one', feature: 'paste', record: {
    reason: 'ready', applied: true, plainLength: 5, htmlLength: 12, removedLeading: 1, removedTrailing: 1,
  } }]);
  assert.equal(await service.receive('window-one', { kind: 'other' }), false);
  await assert.rejects(service.receive('window-one', { kind: 'chat-diagnostic', feature: 'paste', record: { ...record, reason: 'must-not-be-logged' } }), /Invalid paste diagnostic/);
  assert.equal(await service.receive('window-one', { kind: 'chat-diagnostic', feature: 'timer', record: { kind: 'render', threadId: 'fixture', active: true, text: 'must-not-be-logged' } }), true);
  assert.deepEqual(logs.at(-1), { event: 'chat-diagnostic', targetId: 'window-one', feature: 'timer', record: { kind: 'render', threadId: 'fixture', active: true } });
  assert.equal(await service.receive('window-one', { kind: 'chat-diagnostic', feature: 'scroll', record: [{ kind: 'started', runId: 'fixture' }] }), true);
  assert.deepEqual(logs.at(-1), { event: 'chat-diagnostic', targetId: 'window-one', feature: 'scroll', record: [{ kind: 'started', runId: 'fixture' }] });
  assert.equal(await service.receive('window-one', { kind: 'chat-diagnostic', feature: 'scroll-handoff', record: { kind: 'scroll-handoff-decision', reason: 'keys-unchanged' } }), true);
  assert.equal(logs.at(-1).record.reason, 'keys-unchanged');
  await assert.rejects(service.receive('window-one', { kind: 'chat-diagnostic', feature: 'scroll', record: {} }), /Invalid scroll diagnostic/);
  service.close();
});

test('Kit runtime routes paste metadata to the configured shared log', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codextopkits-paste-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const artifact = path.join(root, 'artifact'), stateDirectory = path.join(root, 'state');
  await fs.mkdir(artifact); await fs.mkdir(stateDirectory);
  await fs.writeFile(path.join(artifact, 'kit.json'), JSON.stringify(kit.manifest), 'utf8');
  await fs.writeFile(path.join(artifact, 'index.mjs'), kitModule(kit), 'utf8');
  const logs = [], client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'window-one', type: 'page', url: 'app://index.html' }],
    async send(method) {
      if (method === 'Target.attachToTarget') return { sessionId: 'session-one' };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-one' };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    }, async close() { this.closed = true; } };
  const context = { stateDirectory, cdp: { acquire: async () => client, onReconnect: () => () => {} },
    log: async value => logs.push(value), setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
  const runtime = await kitRuntime({ artifacts: [artifact], services: { 'chat-diagnostics': { module: 'codex-toolkit-chat/diagnostic-service' } } }).start(context);
  t.after(() => runtime.close()); await runtime.connect();
  const record = { reason: 'ready', applied: true, plainLength: 5, htmlLength: 12, removedLeading: 1, removedTrailing: 1 };
  for (const handler of client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'session-one', params: {
    name: '__CODEXTOPKITS_FEATURE_ACTION__', payload: JSON.stringify({ kind: 'chat-diagnostic', feature: 'paste', record }),
  } });
  assert.ok(logs.some(value => value.event === 'chat-diagnostic' && value.targetId === 'window-one' && value.record.reason === 'ready'));
});
