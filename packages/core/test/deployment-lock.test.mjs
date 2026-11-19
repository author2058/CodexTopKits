import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withDeploymentLease } from '../src/deployment-lock.mjs';

test('preparation and application have one short-lived OS owner with no stale file lock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-deployment-owner-')), config = path.join(root, 'toolkit.json');
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const first = withDeploymentLease(config, () => { entered(); return new Promise(resolve => { release = resolve; }); });
  await ready;
  await assert.rejects(withDeploymentLease(config, () => { throw new Error('Competing body must not run'); }), /already in progress/);
  release('first'); assert.equal(await first, 'first');
  assert.equal(await withDeploymentLease(config, () => 'next'), 'next');
  assert.deepEqual(await fs.readdir(root), []);
});

test('an operation failure keeps its original identity and releases ownership', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-deployment-failure-')), config = path.join(root, 'toolkit.json'), failure = new SyntaxError('original operation');
  await assert.rejects(withDeploymentLease(config, () => { throw failure; }), error => error === failure);
  assert.equal(await withDeploymentLease(config, () => true), true);
});
