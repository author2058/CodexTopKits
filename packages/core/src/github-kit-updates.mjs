import https from 'node:https';
import tls from 'node:tls';
import { createHash } from 'node:crypto';

const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
const pattern = /^([a-z][a-z0-9-]*)-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.kit\.gz$/;
const cdnHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export function compareKitVersions(a, b) {
  const version = value => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Invalid Kit version: ' + value);
    const parts = value.split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid Kit version: ' + value);
    return parts;
  };
  const left = version(a), right = version(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function githubRequest(url, headers, signal) {
  const agent = new https.Agent({ proxyEnv: process.env, ca: [...tls.getCACertificates('default'), ...tls.getCACertificates('system')] });
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, agent, signal }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', error => { agent.destroy(); reject(error); });
      response.on('end', () => { agent.destroy(); resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }); });
    });
    request.on('error', error => { agent.destroy(); reject(error); });
  });
}

export function createGithubKitUpdates(repository, { request = githubRequest } = {}) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) throw new Error('GitHub updates require an owner/repository name.');
  const api = 'https://api.github.com/repos/' + repository;
  const headers = (token, accept) => {
    if (token && (typeof token !== 'string' || /[\r\n]/.test(token))) throw new Error('Invalid GitHub token.');
    return { accept, 'user-agent': 'CodexTopKits', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: 'Bearer ' + token } : {}) };
  };
  const getJson = async (url, token, signal) => {
    const response = await request(url, headers(token, 'application/vnd.github+json'), signal);
    if (response.status !== 200) throw new Error('GitHub update lookup failed (HTTP ' + response.status + '); check the repository and access.');
    return { ...response, value: decode(response.bytes) };
  };
  return {
    async list(token, installedVersions, signal) {
      const release = (await getJson(api + '/releases/tags/kits', token, signal)).value;
      if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error('GitHub Kit release has no valid ID.');
      const latest = new Map();
      let page = 1, more;
      do {
        const response = await getJson(api + '/releases/' + release.id + '/assets?per_page=100&page=' + page, token, signal);
        if (!Array.isArray(response.value)) throw new Error('Invalid GitHub Kit asset list.');
        for (const asset of response.value) {
          const match = typeof asset.name === 'string' && pattern.exec(asset.name);
          if (!match || asset.state !== 'uploaded') continue;
          if (installedVersions && !installedVersions.has(match[1])) continue;
          const version = match.slice(2).join('.'); compareKitVersions(version, version);
          if (installedVersions && compareKitVersions(version, installedVersions.get(match[1])) <= 0) continue;
          const item = { id: match[1], version, assetId: asset.id, size: asset.size, digest: asset.digest, name: asset.name };
          const previous = latest.get(item.id);
          if (!previous || compareKitVersions(item.version, previous.version) > 0) latest.set(item.id, item);
        }
        more = /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers.link ?? ''); page++;
      } while (more);
      return [...latest.values()].map(item => {
        if (!Number.isSafeInteger(item.assetId) || item.assetId <= 0 || !Number.isSafeInteger(item.size) || item.size < 0 || !/^sha256:[a-f0-9]{64}$/.test(item.digest ?? '')) throw new Error('Kit release asset lacks a valid ID, size or SHA256: ' + item.name);
        return { id: item.id, version: item.version, assetId: item.assetId, size: item.size, sha256: item.digest.slice(7) };
      });
    },
    async download(asset, token, signal) {
      if (!Number.isSafeInteger(asset.assetId) || asset.assetId <= 0 || !Number.isSafeInteger(asset.size) || asset.size < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '')) throw new Error('Invalid Kit release asset.');
      const original = api + '/releases/assets/' + asset.assetId, visited = new Set();
      let url = new URL(original);
      for (;;) {
        if (visited.has(url.href)) throw new Error('GitHub Kit download redirect loop.');
        visited.add(url.href);
        const apiRequest = url.href === original;
        if (url.protocol !== 'https:' || url.username || url.password || !apiRequest && !cdnHosts.has(url.hostname)) throw new Error('GitHub Kit download redirected to an untrusted address.');
        const response = await request(url.href, headers(apiRequest ? token : undefined, 'application/octet-stream'), signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.headers.location) throw new Error('GitHub Kit download redirect has no destination.');
          url = new URL(response.headers.location, url); continue;
        }
        if (response.status !== 200) throw new Error('GitHub Kit download failed (HTTP ' + response.status + ').');
        if (response.bytes.length !== asset.size || createHash('sha256').update(response.bytes).digest('hex') !== asset.sha256) throw new Error('GitHub Kit download size or SHA256 does not match its release.');
        return response.bytes;
      }
    },
  };
}
