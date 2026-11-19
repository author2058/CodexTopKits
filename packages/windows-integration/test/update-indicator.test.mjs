import test from 'node:test';
import assert from 'node:assert/strict';
import { installHostedUpdateControl, updateIndicatorCss } from '../src/update-indicator.mjs';
import kit from '../kits/update-restart-protection/index.mjs';

test('the update marker retains its original vivid green in either appearance', () => {
  assert.match(updateIndicatorCss(), /background:#22c55e;/);
  assert.doesNotMatch(updateIndicatorCss(), /light-dark|color-mix/);
});

test('the update Kit refuses a Core host without the shared-port contract', () => {
  assert.throws(() => kit.create({ document: { defaultView: {} } }, kit.helpers), /requires Core 0\.3\.19/);
});

function fixture({ failure, registration = { registered: true, hookInstalled: true, hookVerified: true } } = {}) {
  let installs = 0, writes = 0;
  const errors = [], attributes = new Map(), statuses = [];
  const button = { disabled: false,
    __reactFiber$test: { type: function update() { return { id: 'appHeader.installUpdate' }; } },
    getAttribute: key => attributes.get(key) ?? null,
    setAttribute(key, value) { writes++; attributes.set(key, value); },
    removeAttribute: key => attributes.delete(key),
  };
  const original = Object.assign(function rpc() {}, {
    installUpdate(...args) { installs++; return args; },
    checkForUpdates() { throw new Error('must not check for updates'); },
    takeResumeState: () => 'native-resume',
  });
  const native = { services: { appUpdates: original } };
  const control = installHostedUpdateControl({ document: { querySelectorAll: () => [button] } }, native, {
    async registerRestart() { if (failure) throw failure; return registration; },
    onStatus: s => statuses.push(s), onError: e => errors.push(e),
  });
  return { original, native, control, button, errors, statuses, counts: () => ({ installs, writes }) };
}

test('registration preserves the native update service and every method exactly', async () => {
  const f = fixture();
  assert.equal(f.native.services.appUpdates, f.original);
  const install = f.original.installUpdate;
  await f.control.ready;
  assert.equal(f.native.services.appUpdates.installUpdate, install);
  assert.deepEqual(f.native.services.appUpdates.installUpdate('original', 42), ['original', 42]);
  assert.equal(f.counts().installs, 1);
  f.control.cleanup();
  assert.equal(f.native.services.appUpdates, f.original);
});

test('green dot requires confirmed registration and is idempotent', async () => {
  const f = fixture();
  assert.equal(f.button.getAttribute('data-cdt-hosted-update'), null);
  await f.control.ready;
  assert.equal(f.button.getAttribute('data-cdt-hosted-update'), 'active');
  f.control.refreshButtons();
  assert.equal(f.counts().writes, 1);
  f.button.disabled = true; f.control.refreshButtons();
  assert.equal(f.button.getAttribute('data-cdt-hosted-update'), null);
  f.button.disabled = false; f.control.refreshButtons();
  assert.equal(f.button.getAttribute('data-cdt-hosted-update'), 'active');
  f.control.cleanup();
  assert.equal(f.button.getAttribute('data-cdt-hosted-update'), null);
});

test('registration error is retained and never blocks or replaces official install', async () => {
  const failure = new Error('Windows registration rejected');
  const f = fixture({ failure });
  await assert.rejects(f.control.ready, e => e === failure);
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.control.status().error, failure.message);
  assert.equal(f.button.getAttribute('data-cdt-hosted-update'), null);
  assert.deepEqual(f.native.services.appUpdates.installUpdate('native'), ['native']);
  assert.equal(f.counts().installs, 1);
});

test('one-time registration without a verified native guard cannot light the green dot', async () => {
  for (const registration of [{ registered: true }, { registered: true, hookInstalled: true, hookVerified: false }]) {
    const f = fixture({ registration });
    await assert.rejects(f.control.ready, /Native update restart protection was not confirmed/);
    assert.equal(f.button.getAttribute('data-cdt-hosted-update'), null);
    assert.equal(f.control.status().installed, false);
    assert.deepEqual(f.native.services.appUpdates.installUpdate('native'), ['native']);
    f.control.cleanup();
  }
});

test('cleanup while registering cannot light a stale button', async () => {
  const f = fixture(); f.control.cleanup(); await f.control.ready;
  assert.equal(f.control.status().installed, false);
  assert.equal(f.button.getAttribute('data-cdt-hosted-update'), null);
});
