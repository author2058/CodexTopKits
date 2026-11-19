import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { serveImageReferences } from '../src/image-reference-service.mjs';

test('PowerShell certificate generation works without OpenSSL or system certificate changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-certificate-'));
  const old = new Map(['CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE'].map(key => [key, process.env[key]]));
  for (const key of old.keys()) delete process.env[key];
  let service;
  try {
    service = await serveImageReferences(directory);
    const certificate = new X509Certificate(await fs.readFile(service.state.caPath));
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(certificate.checkHost('localhost'), 'localhost');
    assert.equal(certificate.ca, false);
    const socket = tls.connect({ host: '127.0.0.1', port: service.proxy.server.address().port, ca: await fs.readFile(service.state.caPath) });
    try {
      await once(socket, 'secureConnect'); assert.equal(socket.authorized, true);
      await assert.rejects(service.setTransform(async () => async value => value), /drain method/);
      let cachePath; await service.setTransform(async options => { cachePath = options.cachePath; const transform = async value => value; transform.drain = async () => {}; return transform; });
      assert.equal(cachePath, path.join(directory, 'cache.json')); assert.equal(socket.destroyed, false);
      await service.disableTransform(); assert.equal(socket.destroyed, false);
    }
    finally { const closed = once(socket, 'close'); socket.destroy(); await closed; }
    const before = await fs.readFile(path.join(directory, 'loopback-cert.pem'));
    await service.proxy.close(); service = null;
    service = await serveImageReferences(directory);
    assert.deepEqual(await fs.readFile(path.join(directory, 'loopback-cert.pem')), before);
  } finally {
    await service?.proxy.close();
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(os.tmpdir()));
    await fs.rm(directory, { recursive: true });
  }
});
