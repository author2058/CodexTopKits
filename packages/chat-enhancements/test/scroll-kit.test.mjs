import test from 'node:test';
import assert from 'node:assert/strict';
import { createKitHost, kitModule } from 'codex-toolkit-core/kits';
import fix from '../kits/scroll-handoff-fix/index.mjs';
import diagnostics from '../kits/scroll-diagnostics/index.mjs';
import { featureDom } from './feature-dom.mjs';

test('scroll Kits route local notifications and diagnostics while stopping independently', async () => {
  const fixture = featureDom(), { document, main } = fixture, view = document.defaultView;
  const events = new Map(), actions = [], received = [];
  let fixStopped = 0, diagnosticStopped = 0;
  main.matches = selector => selector.startsWith('main.'); main.closest = () => null;
  Object.defineProperty(main, 'isConnected', { get: () => Boolean(main.parentElement) });
  view.crypto = { randomUUID: () => 'fixture-run' };
  view.addEventListener = (type, listener) => events.set(type, listener);
  view.removeEventListener = (type, listener) => { if (events.get(type) === listener) events.delete(type); };
  const shared = { readNativeConversationIdentity: () => ({ hostId: 'local' }), readNativeNotification: data => ({ method: data.method, params: data.params }) };
  const selectedFix = { ...fix, helpers: { ...fix.helpers, ...shared, installScrollHandoffRepair(_document, _correction, report) {
    report({ kind: 'scroll-handoff-decision', reason: 'keys-unchanged' });
    return { refresh() {}, cleanup() { fixStopped++; } };
  } } };
  const selectedDiagnostic = { ...diagnostics, helpers: { ...diagnostics.helpers, ...shared, installScrollDiagnostics(_document, notifications, report, _failure, runId) {
    const unsubscribe = notifications.addNotificationCallback(['turn/completed'], notification => received.push(notification));
    report([{ kind: 'started', runId }]);
    return { refresh() {}, cleanup() { diagnosticStopped++; unsubscribe(); } };
  } } };
  const host = createKitHost([selectedFix, selectedDiagnostic], { document, serviceVersionChecks: true, dispatch: action => actions.push(action) });
  await host.start('scroll-handoff-fix'); await host.start('scroll-diagnostics');
  assert.deepEqual(actions.map(action => action.feature), ['scroll-handoff', 'scroll']);
  events.get('message')({ data: { type: 'mcp-notification', hostId: 'remote', method: 'turn/completed', params: {} } });
  events.get('message')({ data: { type: 'mcp-notification', hostId: 'local', method: 'turn/completed', params: { threadId: 'one' } } });
  assert.equal(received.length, 1); assert.equal(received[0].params.threadId, 'one');
  await host.stop('scroll-handoff-fix'); assert.equal(fixStopped, 1); assert.equal(diagnosticStopped, 0);
  await host.close(); assert.equal(diagnosticStopped, 1); assert.equal(events.size, 0); assert.equal(fixture.observers.size, 0);
  assert.ok(!kitModule(fix).includes('function installScrollDiagnostics('));
  assert.ok(!kitModule(diagnostics).includes('function installScrollHandoffRepair('));
});
