import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGithubKitUpdates, compareKitVersions } from '../src/github-kit-updates.mjs';

const json = (value, headers = {}) => ({ status: 200, headers, bytes: Buffer.from(JSON.stringify(value)) });
const asset = (id, name, bytes = Buffer.from('Kit')) => ({ id, name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') });

test('GitHub Kit lookup selects each Kit version independently across asset pages', async () => {
  const calls = [], request = async (url, headers) => {
    calls.push({ url, headers });
    if (url.endsWith('/releases/tags/kits')) return json({ id: 7 });
    if (url.endsWith('page=1')) return json([{ ...asset(1, 'footer-v0.1.2.kit.gz'), digest: null }, asset(2, 'table-style-v0.1.1.kit.gz')], { link: '<https://api.github.com/example?page=2>; rel="next"' });
    return json([asset(3, 'footer-v0.1.10.kit.gz'), asset(4, 'notes.txt')]);
  };
  const updates = createGithubKitUpdates('owner/repo', { request });
  const values = await updates.list('secret');
  assert.deepEqual(values.map(({ id, version, assetId }) => ({ id, version, assetId })), [{ id: 'footer', version: '0.1.10', assetId: 3 }, { id: 'table-style', version: '0.1.1', assetId: 2 }]);
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.headers.authorization === 'Bearer secret'));
  assert.ok(compareKitVersions('0.1.10', '0.1.2') > 0); assert.throws(() => compareKitVersions('0.01.0', '0.1.0'), /Invalid/);
  assert.deepEqual(await updates.list('secret', new Map([['footer', '0.1.10']])), []);
});

test('GitHub downloads verify size and SHA256 without forwarding credentials to the CDN', async () => {
  const bytes = Buffer.from('selected Kit bytes'), descriptor = asset(42, 'footer-v0.1.2.kit.gz', bytes), calls = [];
  const request = async (url, headers) => {
    calls.push({ url, headers });
    if (url.startsWith('https://api.github.com/')) return { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file?temporary=secret' }, bytes: Buffer.alloc(0) };
    return { status: 200, headers: {}, bytes };
  };
  const updates = createGithubKitUpdates('owner/repo', { request });
  const selected = { assetId: descriptor.id, size: descriptor.size, sha256: descriptor.digest.slice(7) };
  assert.deepEqual(await updates.download(selected, 'secret'), bytes);
  assert.equal(calls[0].headers.authorization, 'Bearer secret'); assert.equal(calls[1].headers.authorization, undefined);
  await assert.rejects(updates.download({ ...selected, sha256: '0'.repeat(64) }, 'secret'), /SHA256/);
  const hostile = createGithubKitUpdates('owner/repo', { request: async () => ({ status: 302, headers: { location: 'https://example.com/steal' }, bytes: Buffer.alloc(0) }) });
  await assert.rejects(hostile.download(selected, 'secret'), /untrusted address/);
});

test('GitHub lookup reports missing access and unverifiable release assets', async () => {
  assert.throws(() => createGithubKitUpdates('https://example.com/repo'), /owner\/repository/);
  const missing = createGithubKitUpdates('owner/repo', { request: async () => ({ status: 404, headers: {}, bytes: Buffer.alloc(0) }) });
  await assert.rejects(missing.list('secret'), /HTTP 404.*access/);
  const unverifiable = createGithubKitUpdates('owner/repo', { request: async url => url.endsWith('/tags/kits') ? json({ id: 1 }) : json([{ ...asset(2, 'footer-v0.1.2.kit.gz'), digest: null }]) });
  await assert.rejects(unverifiable.list(), /SHA256/);
});
