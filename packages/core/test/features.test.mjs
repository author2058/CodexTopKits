import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureHost, resolveFeatures, featurePayload, featureModule } from '../src/features.mjs';

const define = (id, dependencies = {}, create = async () => ({ close() {} }), version = '0.1.0') => ({
  manifest: { id, version, entry: 'index.mjs', coreApiVersion: 1, dependencies }, create,
});

test('optional default selection is boolean and does not prevent explicit Kit resolution', () => {
  const optional = define('optional'); optional.manifest.defaultEnabled = false;
  assert.equal(resolveFeatures([optional])[0], optional);
  optional.manifest.defaultEnabled = 'false';
  assert.throws(() => resolveFeatures([optional]), /Invalid feature definition/);
});

test('features have their own versions, exact dependency checks and dependency order', () => {
  const footer = define('footer'), usage = define('weekly-usage', { footer: '0.1.0' }, undefined, '0.2.0');
  assert.deepEqual(resolveFeatures([usage, footer]).map(value => value.manifest.id), ['footer', 'weekly-usage']);
  assert.equal(usage.manifest.version, '0.2.0');
  assert.throws(() => resolveFeatures([usage]), /Missing feature dependency/);
  assert.throws(() => resolveFeatures([usage, { ...footer, manifest: { ...footer.manifest, version: '0.2.0' } }]), /Incompatible feature dependency/);
  assert.throws(() => resolveFeatures([footer, footer]), /Duplicate feature/);
  assert.throws(() => resolveFeatures([define('a', { b: '0.1.0' }), define('b', { a: '0.1.0' })]), /cycle/);
});

test('Kit dependency ranges accept compatible releases and reject incompatible or unsupported ranges', async () => {
  const { resolveKits, createKitHost } = await import('codex-toolkit-core/kits');
  const footer = version => ({ ...define('footer'), manifest: { ...define('footer').manifest, version } });
  const usage = range => define('weekly-usage', { footer: range });
  for (const [range, version] of [['^0.1.1', '0.1.1'], ['^0.1.1', '0.1.9'], ['^1.2.3', '1.9.0'], ['^0.0.3', '0.0.3']]) {
    assert.doesNotThrow(() => resolveKits([usage(range), footer(version)]));
  }
  for (const [range, version] of [['^0.1.1', '0.1.0'], ['^0.1.1', '0.2.0'], ['^1.2.3', '2.0.0'], ['^0.0.3', '0.0.4']]) {
    assert.throws(() => resolveKits([usage(range), footer(version)]), /Incompatible/);
  }
  assert.throws(() => resolveKits([usage('>=0.1.0'), footer('0.1.1')]), /Invalid feature dependency version/);
  assert.equal(createKitHost, createFeatureHost);
  assert.equal((await import('codex-toolkit-core/kits/footer')).default, (await import('codex-toolkit-core/plugins/footer')).default);
});

test('starting a feature starts only required dependencies and duplicate starts share one lifecycle', async () => {
  const calls = [], footer = define('footer', {}, async () => { calls.push('footer'); return { marker: 1, close() { calls.push('close-footer'); } }; });
  const usage = define('weekly-usage', { footer: '0.1.0' }, async ({ dependencies }) => {
    assert.equal(dependencies.footer.marker, 1); calls.push('usage'); return { close() { calls.push('close-usage'); } };
  });
  const host = createFeatureHost([usage, footer, define('unused', {}, () => assert.fail('Unused feature started'))]);
  const [a, b] = await Promise.all([host.start('weekly-usage'), host.start('weekly-usage')]);
  assert.equal(a, b); assert.deepEqual(calls, ['footer', 'usage']);
  await assert.rejects(host.stop('footer'), /required by weekly-usage/);
  await host.close(); assert.deepEqual(calls, ['footer', 'usage', 'close-usage', 'close-footer']);
  await assert.rejects(host.start('footer'), /closed/);
});

test('startup and cleanup errors retain their original identity and health record', async () => {
  let closed = false;
  const error = new TypeError('Original startup failure'), host = createFeatureHost([
    define('dependency', {}, () => ({ close() { closed = true; } })), define('broken', { dependency: '0.1.0' }, () => { throw error; }),
  ]);
  await assert.rejects(host.start('broken'), value => value === error);
  assert.equal(host.snapshot()[1].error.stack, error.stack); await host.close(); assert.equal(closed, true);
  const cleanup = new SyntaxError('Original cleanup failure'), other = createFeatureHost([define('bad-close', {}, () => ({ close() { throw cleanup; } }))]);
  await other.start('bad-close'); await assert.rejects(other.stop('bad-close'), value => value === cleanup);
  assert.equal(other.snapshot()[0].error.stack, cleanup.stack);
});

test('restart preflight preserves all active Kits when one cannot restart', async () => {
  let calls = 0, blocked = true;
  const guard = define('guard', {}, () => ({ beforeRestart() { if (blocked) throw new Error('Voice is active.'); }, close() { calls++; } }));
  const other = define('other', {}, () => ({ close() { calls++; } }));
  const host = createFeatureHost([guard, other]); await host.start('guard'); await host.start('other');
  await assert.rejects(host.checkRestart(), /Voice is active/);
  assert.equal(calls, 0); assert.deepEqual(host.snapshot().map(value => value.state), ['running', 'running']);
  blocked = false; await host.checkRestart(); await host.close(); assert.equal(calls, 2);
});

test('an independent module preserves its own manifest and helpers without bundling dependencies', async () => {
  const source = featureModule({ ...define('weekly-usage', { footer: '0.1.0' }, (_context, { marker }) => ({ marker: marker(), close() {} })), helpers: { marker: () => 42 } });
  const { default: loaded } = await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'));
  assert.equal(loaded.manifest.dependencies.footer, '0.1.0');
  assert.equal(loaded.create({}, loaded.helpers).marker, 42);
  assert.ok(!source.includes('createFeatureHost'));
  assert.throws(() => featureModule({ ...define('bad'), helpers: { 'bad-name': () => 1 } }), /Invalid feature helper/);
  assert.throws(() => featureModule({ ...define('bad'), helpers: { default: () => 1 } }), SyntaxError);
});

test('versioned service Kits refuse older and unverified hosts', async () => {
  const definition = { ...define('versioned'), manifest: { ...define('versioned').manifest, minimumCoreVersion: '0.3.23', services: ['example'], serviceVersions: { example: '^1.0.0' } } };
  assert.throws(() => featureModule({ ...definition, manifest: { ...definition.manifest, minimumCoreVersion: '0.3.22' } }), /requires Core 0\.3\.23/);
  assert.throws(() => featureModule({ ...definition, manifest: { ...definition.manifest, minimumCoreVersion: 'invalid' } }), /requires Core 0\.3\.23/);
  assert.doesNotThrow(() => featureModule({ ...definition, manifest: { ...definition.manifest, minimumCoreVersion: '0.4.0' } }));
  const source = featureModule(definition);
  const loaded = (await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))).default;
  assert.throws(() => loaded.create({}), /requires verified service versions/);
  assert.equal(typeof (await loaded.create({ serviceVersionChecks: true })).close, 'function');
  const unverified = createFeatureHost([definition]);
  await assert.rejects(unverified.start('versioned'), /requires verified service versions/);
  assert.equal(unverified.snapshot()[0].state, 'stopped');
  const verified = createFeatureHost([loaded], { serviceVersionChecks: true });
  await verified.start('versioned');
  assert.equal(verified.snapshot()[0].state, 'running');
  await verified.close();
});

test('Kit artifacts do not vary with source checkout line endings', () => {
  const createWith = ending => new Function('return (function create() {' + ending + '  return { close() {} };' + ending + '})')();
  const helperWith = ending => new Function('return (function marker() {' + ending + '  return 42;' + ending + '})')();
  const lf = { ...define('line-endings'), create: createWith('\n'), helpers: { marker: helperWith('\n') } };
  const crlf = { ...define('line-endings'), create: createWith('\r\n'), helpers: { marker: helperWith('\r\n') } };
  assert.notEqual(lf.create.toString(), crlf.create.toString());
  assert.equal(featureModule(lf), featureModule(crlf));
});

test('a payload includes only explicitly supplied feature definitions and refuses duplicate IDs', () => {
  const payload = featurePayload([define('footer')]);
  assert.ok(payload.includes('"id":"footer"')); assert.ok(!payload.includes('weekly-usage'));
  assert.doesNotThrow(() => new Function('return ' + payload));
  assert.throws(() => featurePayload([define('footer'), define('footer')]), /Duplicate/);
});

test('unrelated DOM success cannot erase a runtime error and state listeners close with their feature', async () => {
  let report, received = 0;
  const host = createFeatureHost([define('test-state', {}, context => {
    report = context.reportError; context.onRuntimeState(() => received++); return { close() {} };
  })]);
  await host.start('test-state'); report(new TypeError('Original native failure'), 'native'); host.refresh();
  assert.equal(host.snapshot()[0].error.message, 'Original native failure');
  host.setRuntimeState({ value: 1 }); assert.equal(received, 1); assert.equal(host.snapshot()[0].error.message, 'Original native failure');
  report(null, 'native'); assert.equal(host.snapshot()[0].error, null);
  await host.stop('test-state'); host.setRuntimeState({ value: 2 }); assert.equal(received, 1); await host.close();
});
