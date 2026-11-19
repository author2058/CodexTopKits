import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startRuntime } from '../src/runtime.mjs';

test('local desktop settings ignore browser language, persist explicit/automatic preferences and stream updates', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-language-manager-'));
  let setHostLanguage;
  const runtime = await startRuntime({ stateDirectory: directory, plugins: [{ id: 'language-source', coreApiVersion: 1, async start(context) {
    setHostLanguage = context.setHostLanguage; setHostLanguage('en-US'); return { close() {} };
  } }] });
  t.after(() => runtime.close());
  const base = runtime.status().managerUrl;
  const initial = await (await fetch(base + 'api/localization', { headers: { 'accept-language': 'zh-CN' } })).json();
  assert.equal(initial.locale, 'en'); assert.equal(initial.hostLanguage, 'en-US');
  assert.deepEqual(initial.preference, { mode: 'auto' });
  const moduleResponse = await fetch(base + 'localization.mjs');
  assert.match(moduleResponse.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline';/);
  const module = await moduleResponse.text();
  const { createLocalization } = await import('data:text/javascript;base64,' + Buffer.from(module, 'utf8').toString('base64'));
  assert.equal(createLocalization().resolve(initial.preference, [initial.hostLanguage, initial.systemLanguage]), 'en');
  assert.equal((await fetch(base + 'api/localization', { method: 'POST', body: '{}' })).status, 403);
  const post = preference => fetch(base + 'api/localization', { method: 'POST', headers: { 'x-codex-toolkit-action': 'manage' }, body: JSON.stringify(preference) });
  assert.equal((await post({ mode: 'fixed', locale: 'zh-CN' })).status, 400);
  const stream = await fetch(base + 'api/events'), reader = stream.body.getReader();
  const read = async () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await reader.read()).value).slice(6).trim());
  await read();
  assert.equal((await (await post({ mode: 'fixed', locale: 'zh-Hans' })).json()).locale, 'zh-Hans');
  assert.equal((await read()).languagePreference.locale, 'zh-Hans');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'language.json'), 'utf8')), { mode: 'fixed', locale: 'zh-Hans' });
  assert.equal((await (await post({ mode: 'auto' })).json()).locale, 'en'); await read();
  setHostLanguage('zh-CN'); assert.equal((await read()).hostLanguage, 'zh-CN');
  assert.equal((await (await fetch(base + 'api/localization')).json()).locale, 'zh-Hans');
  await reader.cancel();
});
