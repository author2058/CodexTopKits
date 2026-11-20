import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const requireValue = (condition, message) => { if (!condition) throw new TypeError(message); };
export const defaults = {
  usage: 'https://speed-api.codexradar.com/api/agent-speed/public/practical?source=codex&window=2h',
  iq: 'https://codexradar.com/data/codex-four-task-results.json',
};

export async function readJson(source, signal) {
  let bytes;
  if (!/^https?:\/\//i.test(source)) bytes = await fs.readFile(source, { signal });
  else {
    const url = new URL(source), secure = url.protocol === 'https:';
    requireValue(!url.username && !url.password, 'Data URLs must not contain credentials.');
    const protocol = secure ? https : http;
    const agent = secure ? new https.Agent({ proxyEnv: process.env, ca: [...tls.getCACertificates('default'), ...tls.getCACertificates('system')] }) : new http.Agent({ proxyEnv: process.env });
    try {
      bytes = await new Promise((resolve, reject) => {
        const request = protocol.get(url, { agent, signal, headers: { accept: 'application/json', 'user-agent': 'CodexTopKits-effort-selector' } }, response => {
          if (response.statusCode !== 200) { response.resume(); reject(Object.assign(new Error('Data request returned HTTP ' + response.statusCode + ': ' + url.href), { statusCode: response.statusCode })); return; }
          const parts = []; response.on('data', b => parts.push(b)); response.once('error', reject); response.once('end', () => resolve(Buffer.concat(parts)));
        });
        request.once('error', reject);
      });
    } finally { agent.destroy(); }
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function loadInputs({ usage = defaults.usage, iq = defaults.iq, signal, timeoutMs = 60000 } = {}) {
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'timeout-ms must be a positive integer.');
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(new DOMException('Input loading exceeded ' + timeoutMs + 'ms.', 'TimeoutError')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  try {
    const [usageData, iqData] = await Promise.all([readJson(usage, combined), readJson(iq, combined)]);
    return { usage: usageData, iq: iqData };
  } finally { clearTimeout(timer); lifetime.abort(); }
}
