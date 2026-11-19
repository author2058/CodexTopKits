import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createImageReferenceProxy } from './image-reference-proxy.mjs';
import { createImageReferenceTransform } from './image-reference-transform.mjs';
import { createTransformRouter } from './transform-router.mjs';

const exec = promisify(execFile);

// Certificates belong to this installation, never the system trust store.
export async function serveImageReferences(stateDir, { opensslPath, powershellPath = 'pwsh', log, externalImageTransform = false } = {}) {
  if (!path.isAbsolute(stateDir)) throw new Error('Pass an absolute, dedicated bandwidth state directory.');
  await fs.mkdir(stateDir, { recursive: true });
  const keyPath = path.join(stateDir, 'loopback-key.pem'), certPath = path.join(stateDir, 'loopback-cert.pem');
  let renew = false;
  try { renew = Date.parse(new X509Certificate(await fs.readFile(certPath)).validTo) <= Date.now(); }
  catch (error) { if (error.code === 'ENOENT') renew = true; else throw error; }
  if (renew) {
    const command = opensslPath ?? powershellPath;
    const args = opensslPath
      ? ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', keyPath, '-out', certPath, '-days', '365', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment', '-addext', 'extendedKeyUsage=serverAuth']
      : ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./create-loopback-certificate.ps1', import.meta.url)), '-KeyPath', keyPath, '-CertPath', certPath];
    await exec(command, args, { windowsHide: true, encoding: 'utf8' });
  }
  const tls = { key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) };
  const inheritedCa = process.env.CODEX_CA_CERTIFICATE || process.env.SSL_CERT_FILE;
  const caPath = path.join(stateDir, 'native-ca-bundle.pem');
  const bundle = inheritedCa && path.resolve(inheritedCa) !== caPath
    ? Buffer.concat([await fs.readFile(inheritedCa), Buffer.from('\n', 'utf8'), tls.cert]) : tls.cert;
  await fs.writeFile(caPath, bundle);
  const record = log ?? (entry => fs.appendFile(path.join(stateDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n', 'utf8'));
  const options = { cachePath: path.join(stateDir, 'cache.json'), log: record };
  const router = createTransformRouter(await createImageReferenceTransform({ ...options, enabled: !externalImageTransform }));
  const proxy = await createImageReferenceProxy({ tls, transform: (data, context) => router.apply(data, context), log: record });
  try {
    const state = { version: 1, metricsVersion: 1, pid: process.pid, startedAt: new Date().toISOString(), baseUrl: proxy.baseUrl, caPath, certExpiresAt: new X509Certificate(tls.cert).validTo };
    await fs.writeFile(path.join(stateDir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
    await record({ event: 'ready', metricsVersion: 1, port: proxy.server.address().port, certExpiresAt: state.certExpiresAt });
    return { state, proxy, setTransform: factory => router.replace(async () => {
      const transform = await factory(options);
      if (typeof transform !== 'function' || typeof transform.drain !== 'function') throw new TypeError('Image transform backend must provide a drain method.');
      return transform;
    }),
      disableTransform: () => router.replace(() => createImageReferenceTransform({ ...options, enabled: false })) };
  } catch (error) {
    try { await proxy.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Bandwidth startup and cleanup failed.', { cause: error }); }
    throw error;
  }
}
