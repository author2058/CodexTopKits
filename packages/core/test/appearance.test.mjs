import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { featurePayload } from '../src/features.mjs';
import { startRuntime } from '../src/runtime.mjs';
import { featureDom } from './support/feature-dom.mjs';

test('serialized host reports native appearance once, follows root theme events and releases its observer', async () => {
  const f = featureDom(), { document, observers } = f, window = document.defaultView, actions = [];
  document.documentElement.setAttribute('data-theme', 'light'); window.report = raw => actions.push(JSON.parse(raw));
  await vm.runInNewContext(featurePayload([], { bindingName: 'report' }), { document, window });
  const appearance = () => actions.filter(value => value.kind === 'host-appearance');
  assert.deepEqual(appearance(), [{ kind: 'host-appearance', appearance: 'light' }]);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light'); assert.equal(observers.size, 1);
  f.emitDom([{ attributeName: 'data-theme' }]); assert.equal(appearance().length, 1);
  document.documentElement.setAttribute('data-theme', 'dark'); f.emitDom([{ attributeName: 'data-theme' }]);
  assert.deepEqual(appearance().at(-1), { kind: 'host-appearance', appearance: 'dark' });
  document.documentElement.setAttribute('data-theme', 'unexpected'); f.emitDom([{ attributeName: 'data-theme' }]);
  assert.equal(appearance().length, 2);
  await window.__CODEXTOPKITS_FEATURE_HOST__.close(); assert.equal(observers.size, 0); assert.equal(f.intervals.size, 0);
});

test('native appearance reaches settings state and streams without changing language or restarting plugins', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-appearance-'));
  let setAppearance, starts = 0;
  const runtime = await startRuntime({ stateDirectory: directory, plugins: [{ id: 'appearance-source', coreApiVersion: 1, async start(context) {
    starts++; setAppearance = context.setHostAppearance; setAppearance('light'); return { close() {} };
  } }] });
  t.after(() => runtime.close());
  const base = runtime.status().managerUrl;
  const initial = await (await fetch(base + 'api/localization')).json();
  assert.equal(initial.hostAppearance, 'light'); assert.equal(runtime.status().hostAppearance, 'light');
  const response = await fetch(base + 'api/events'), reader = response.body.getReader();
  const read = async () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await reader.read()).value).slice(6).trim());
  assert.equal((await read()).hostAppearance, 'light');
  assert.equal(setAppearance('dark'), true);
  const changed = await read(); assert.equal(changed.hostAppearance, 'dark'); assert.deepEqual(changed.languagePreference, { mode: 'auto' });
  assert.equal(setAppearance('dark'), false); assert.throws(() => setAppearance('auto'), /Invalid host appearance/);
  assert.equal(starts, 1); assert.equal((await (await fetch(base + 'api/localization')).json()).hostAppearance, 'dark');
  await reader.cancel();
});
