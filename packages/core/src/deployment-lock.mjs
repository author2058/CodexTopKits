import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

// A short-lived OS owner coordinates preparation and application; a crashed owner leaves no lock file.
export async function withDeploymentLease(configPath, operation) {
  const root = (await fs.realpath(path.dirname(configPath))).toLowerCase();
  const key = createHash('sha256').update(root, 'utf8').digest('hex');
  const endpoint = process.platform === 'win32' ? String.raw`\\.\pipe\codextopkits-deployment-${key}` : '\0codextopkits-deployment-' + key;
  const server = net.createServer(socket => socket.destroy());
  server.listen(endpoint);
  try { await once(server, 'listening'); }
  catch (error) { if (error.code === 'EADDRINUSE') throw new Error('Another Toolkit update is already in progress.', { cause: error }); throw error; }
  let result, failure, failed = false;
  try { result = await operation(); } catch (error) { failure = error; failed = true; }
  try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  catch (cleanup) { if (failed) throw new AggregateError([failure, cleanup], 'Deployment and owner cleanup failed.', { cause: failure }); throw cleanup; }
  if (failed) throw failure;
  return result;
}
