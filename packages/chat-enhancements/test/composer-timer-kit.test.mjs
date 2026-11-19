import test from 'node:test';
import assert from 'node:assert/strict';
import { kitModule } from 'codex-toolkit-core/kits';
import kit from '../kits/composer-timer/index.mjs';
import { featureDom } from './feature-dom.mjs';

test('packaged timer Kit reports the original native discovery failure without retrying', async () => {
  const source = kitModule(kit), definition = (await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))).default;
  const { document, observers } = featureDom(), events = new Map(), errors = [], failure = new TypeError('native fixture discovery failed');
  document.defaultView.addEventListener = (name, listener) => events.set(name, listener);
  document.defaultView.removeEventListener = name => events.delete(name);
  let calls = 0, closed = false;
  const helpers = { ...definition.helpers, createNativeAssetReader: () => ({}),
    loadNativeConversationRpc: async () => { calls++; throw failure; }, loadNativeDurationFormatter: async () => () => '1s',
    installComposerUi: () => ({ ready() {}, refresh() {}, renderText() {}, receive() {}, cleanup() { closed = true; } }) };
  const instance = definition.create({ document, serviceVersionChecks: true, onDomChange: () => () => {}, dispatch() {}, reportError: (error, source) => errors.push({ error, source }),
    i18n: { locale: 'en', onChange: () => () => {}, t: (messages, key) => messages.en[key] } }, helpers);
  await new Promise(setImmediate);
  assert.equal(calls, 1); assert.ok(errors.some(value => value.source === 'conversation-rpc' && value.error === failure));
  instance.close(); assert.equal(closed, true); assert.equal(events.size, 0); assert.equal(observers.size, 0);
});
