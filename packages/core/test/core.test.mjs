import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPluginHost, CORE_API_VERSION } from '../src/index.mjs';

async function state(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-toolkit-core-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(os.tmpdir()));
    await fs.rm(directory, { recursive: true });
  });
  return directory;
}

test('an empty host imports no plugins and opens no application or CDP connection', async t => {
  const directory = await state(t);
  const host = await createPluginHost({ stateDirectory: directory });
  assert.deepEqual(host.health().plugins, []);
  assert.equal(host.health().ok, true);
  assert.deepEqual(await fs.readdir(directory), []);
  await host.close();
});

test('plugins share the host while keeping state separate; log text is UTF-8 without BOM', async t => {
  const directory = await state(t), contexts = [], stopped = [];
  const plugins = ['first', 'second'].map(id => ({ id, coreApiVersion: CORE_API_VERSION,
    async start(context) {
      contexts.push(context);
      await context.log({ event: 'test', message: '合成样例' });
      context.setHealth({ ok: true, message: 'Ready.' });
      return { close: async () => { stopped.push(id); } };
    },
  }));
  const host = await createPluginHost({ stateDirectory: directory, plugins });
  assert.equal(host.health().ok, true);
  assert.equal(contexts[0].stateDirectory, path.join(directory, 'plugins', 'first'));
  assert.notEqual(contexts[0].stateDirectory, contexts[1].stateDirectory);
  const bytes = await fs.readFile(path.join(directory, 'events.jsonl'));
  assert.notEqual(bytes[0], 0xef);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(line => line.plugin), ['first', 'second']);
  assert.ok(lines.every(line => line.message === '合成样例' && Number.isFinite(Date.parse(line.at))));
  const firstClose = host.close();
  assert.equal(firstClose, host.close());
  await firstClose;
  assert.deepEqual(stopped, ['second', 'first']);
});

test('incompatible or duplicate plugins fail before any plugin starts', async t => {
  const directory = await state(t);
  let starts = 0;
  const plugin = { id: 'fixture', coreApiVersion: CORE_API_VERSION, start: async () => { starts++; } };
  await assert.rejects(createPluginHost({ stateDirectory: directory, plugins: [plugin, plugin] }), /Duplicate/);
  await assert.rejects(createPluginHost({ stateDirectory: directory, plugins: [{ ...plugin, coreApiVersion: 999 }] }), /Incompatible/);
  await assert.rejects(createPluginHost({ stateDirectory: directory, plugins: [{ ...plugin, id: '../escape' }] }), /Invalid plugin/);
  assert.equal(starts, 0);
});

test('a startup failure stops only this host and preserves the exact original error', async t => {
  const directory = await state(t), failure = new Error('fixture startup failure');
  let closed = 0;
  await assert.rejects(createPluginHost({ stateDirectory: directory, plugins: [
    { id: 'ready', coreApiVersion: 1, start: async () => ({ close: async () => { closed++; } }) },
    { id: 'broken', coreApiVersion: 1, start: async () => { throw failure; } },
  ] }), actual => actual === failure);
  assert.equal(closed, 1);
});

test('unexpected logging errors are not converted into healthy empty records', async t => {
  const directory = await state(t);
  await fs.mkdir(path.join(directory, 'events.jsonl'));
  await assert.rejects(createPluginHost({ stateDirectory: directory, plugins: [
    { id: 'fixture', coreApiVersion: 1, start: async context => { await context.log({ event: 'test' }); } },
  ] }), error => ['EISDIR', 'EPERM', 'EACCES'].includes(error.code));
});
