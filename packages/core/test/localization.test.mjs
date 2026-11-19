import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createLocalization } from '../src/localization.mjs';
import { createPluginHost } from '../src/index.mjs';
import { createFeatureHost, featurePayload } from '../src/features.mjs';
import { featureDom } from './support/feature-dom.mjs';

const messages = { en: { label: 'Clear {count}', english: 'English entry' }, 'zh-Hans': { label: '清理 {count}' } };

test('locale resolution honors the highest environment, supported scripts and explicit BCP 47 selection', () => {
  const localization = createLocalization();
  for (const [environment, expected] of [
    [['en-US', 'zh-CN'], 'en'], [['zh-CN', 'en'], 'zh-Hans'], [['zh', 'en'], 'zh-Hans'],
    [['zh-Hans-SG'], 'zh-Hans'], [['fr-FR', 'zh-CN'], 'en'], [['zh-Hant-TW', 'zh-CN'], 'en'],
    [[null, '', 'zh-CN'], 'zh-Hans'], [['not_a_tag', 'zh-CN'], 'en'], [[], 'en'],
  ]) assert.equal(localization.resolve({ mode: 'auto' }, environment), expected);
  assert.equal(localization.resolve({ mode: 'fixed', locale: 'zh-Hans' }, ['en-US']), 'zh-Hans');
  assert.deepEqual(localization.validatePreference({ mode: 'fixed', locale: 'en' }), { mode: 'fixed', locale: 'en' });
  for (const preference of [null, {}, { mode: 'fixed', locale: 'zh-CN' }, { mode: 'auto', locale: 'en' }, { mode: 'auto', extra: 1 }]) {
    assert.throws(() => localization.validatePreference(preference), /Invalid language preference/);
  }
});

test('shared dictionaries interpolate plain text, fall back to English and surface missing entries', () => {
  const localization = createLocalization();
  assert.equal(localization.translate(messages, 'zh-Hans', 'label', { count: '<2>' }), '清理 <2>');
  assert.equal(localization.translate(messages, 'zh-Hans', 'english'), 'English entry');
  assert.throws(() => localization.translate(messages, 'en', 'missing'), /Missing English translation/);
  assert.throws(() => localization.translate(messages, 'en', 'label'), /Missing translation value/);
  const serialized = vm.runInNewContext('(' + createLocalization.toString() + ')()');
  assert.equal(serialized.resolve({ mode: 'auto' }, ['zh-CN']), 'zh-Hans');
  assert.equal(serialized.translate(messages, 'en', 'label', { count: 2 }), 'Clear 2');
});

test('renderer locale changes follow host priority and release their environment subscriptions', async () => {
  const fixture = featureDom(), { document, observers } = fixture;
  document.documentElement.setAttribute('lang', 'en-US'); document.defaultView.navigator = { language: 'zh-CN' };
  const received = []; let i18n;
  const definition = { manifest: { id: 'localized', version: '0.1.0', coreApiVersion: 1, entry: 'index.mjs', dependencies: {} }, create(context) {
    i18n = context.i18n; const unsubscribe = i18n.onChange(locale => received.push(locale)); return { close: unsubscribe };
  } };
  const host = createFeatureHost([definition], { document, hostState: { languagePreference: { mode: 'auto' }, systemLanguage: 'zh-CN' } });
  await host.start('localized');
  assert.equal(i18n.locale, 'en'); assert.equal(observers.size, 1);
  assert.equal(i18n.t(messages, 'label', { count: 1 }), 'Clear 1');
  document.documentElement.setAttribute('lang', 'zh-CN');
  fixture.emitDom([{ attributeName: 'lang' }]);
  assert.deepEqual(received, ['zh-Hans']); assert.equal(i18n.t(messages, 'label', { count: 1 }), '清理 1');
  fixture.emitDom([{ attributeName: 'lang' }]); assert.equal(received.length, 1);
  host.setHostState({ languagePreference: { mode: 'fixed', locale: 'en' }, systemLanguage: 'zh-CN' });
  document.documentElement.setAttribute('lang', 'fr-FR'); fixture.emitDom([{ attributeName: 'lang' }]);
  assert.deepEqual(received, ['zh-Hans', 'en']);
  await host.stop('localized'); assert.equal(observers.size, 0);
  await host.start('localized'); assert.equal(i18n.locale, 'en');
  await host.close(); assert.equal(observers.size, 0); assert.equal(fixture.intervals.size, 0);
  document.documentElement.removeAttribute('lang'); document.defaultView.navigator.language = 'en-US';
  const withoutHost = createFeatureHost([definition], { document, hostState: { languagePreference: { mode: 'auto' }, systemLanguage: 'zh-CN' } });
  await withoutHost.start('localized'); assert.equal(i18n.locale, 'en');
  document.defaultView.navigator.language = 'zh-CN'; fixture.viewEvents.get('languagechange')();
  assert.equal(i18n.locale, 'zh-Hans');
  await withoutHost.close(); assert.equal(fixture.viewEvents.has('languagechange'), false);
});

test('serialized host reports native host language once and cleans up without modifying its document', async () => {
  const { document, observers } = featureDom(), window = document.defaultView, actions = [];
  document.documentElement.setAttribute('lang', 'en-US'); window.report = value => actions.push(JSON.parse(value));
  await vm.runInNewContext(featurePayload([], { bindingName: 'report' }), { document, window });
  assert.deepEqual(actions.filter(value => value.kind === 'host-language'), [{ kind: 'host-language', language: 'en-US' }]);
  assert.equal(document.documentElement.getAttribute('lang'), 'en-US');
  await window.__CODEXTOPKITS_FEATURE_HOST__.close(); assert.equal(observers.size, 0);
  const original = new Error('Original binding failure');
  assert.throws(() => createFeatureHost([], { document, onHostLanguage() { throw original; } }), error => error === original);
  assert.equal(observers.size, 0);
});

test('shared preference persists in order and native environment updates use the existing state channel', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-language-'));
  const host = await createPluginHost({ stateDirectory: directory }), states = [];
  const unsubscribe = host.onState(state => states.push(state));
  assert.deepEqual(host.languagePreference(), { mode: 'auto' });
  host.setHostLanguage('en-US'); host.setHostLanguage('en-US');
  assert.equal(states.length, 2); assert.equal(states.at(-1).hostLanguage, 'en-US');
  await Promise.all([host.setLanguagePreference({ mode: 'fixed', locale: 'zh-Hans' }), host.setLanguagePreference({ mode: 'fixed', locale: 'en' })]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'language.json'), 'utf8')), { mode: 'fixed', locale: 'en' });
  assert.equal(states.at(-1).languagePreference.locale, 'en'); unsubscribe();
  const saving = host.setLanguagePreference({ mode: 'fixed', locale: 'zh-Hans' }), stopping = host.close();
  await saving; await stopping;
  await assert.rejects(host.setLanguagePreference({ mode: 'auto' }), /stopping/);
  const resumed = await createPluginHost({ stateDirectory: directory });
  assert.deepEqual(resumed.languagePreference(), { mode: 'fixed', locale: 'zh-Hans' }); await resumed.close();
});

test('stored language parse errors surface and write failures preserve the active preference', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-language-error-')), filename = path.join(directory, 'language.json');
  const host = await createPluginHost({ stateDirectory: directory });
  await fs.mkdir(filename);
  await assert.rejects(host.setLanguagePreference({ mode: 'fixed', locale: 'en' }), error => typeof error.code === 'string' && /rename/.test(error.message));
  assert.deepEqual(host.languagePreference(), { mode: 'auto' });
  await fs.rmdir(filename);
  await host.setLanguagePreference({ mode: 'fixed', locale: 'zh-Hans' }); await host.close();
  await fs.writeFile(filename, '{invalid', 'utf8');
  await assert.rejects(createPluginHost({ stateDirectory: directory }), SyntaxError);
});
