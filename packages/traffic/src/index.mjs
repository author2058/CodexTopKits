import { CORE_API_VERSION } from 'codex-toolkit-core';
import path from 'node:path';
import fs from 'node:fs/promises';
import { discoverDesktopCodex, checkCodexImagePolicy } from './check-codex-image-policy.mjs';
import { createNativePolicyWatcher } from './native-image-policy-watch.mjs';
import { createTrafficService } from './traffic-service.mjs';
import { createTrafficObserverRouter } from './traffic-observer-router.mjs';
import { imageIntegrationStatus } from './image-integration.mjs';

// The host owns this instance; no detached process or existing service is touched.
export function bandwidthPlugin({ opensslPath, powershellPath, cdpPort, windowsDirectory, connections = false, codexHome, externalKits = [] } = {}) {
  if (CORE_API_VERSION !== 1) throw new Error('The bandwidth plugin requires core API 1.');
  if (!Array.isArray(externalKits) || externalKits.some(id => !['image-reference-dedup', 'image-policy-rules', 'traffic-observer'].includes(id))) throw new TypeError('Invalid external bandwidth Kit.');
  return {
    id: 'bandwidth',
    coreApiVersion: 1,
    ...(cdpPort !== undefined ? { cdpPort } : {}),
    async start(context) {
      if (cdpPort !== undefined && !context.cdp) throw new Error('Chromium capture requires the shared CDP service from Core 0.3.0 or newer.');
      const { serveImageReferences } = await import('./image-reference-service.mjs');
      let observed = false;
      let trafficErrors = [];
      let trafficIssues = [];
      let policyState = { error: null, report: null, running: false };
      let traffic;
      const publishHealth = () => {
        const forwarding = observed ? 'Model request forwarding has been observed.' : 'Local forwarding is ready; Codex routing has not been verified.';
        const policy = policyState.error ? 'Native image-policy check failed: ' + policyState.error.message
          : policyState.running ? 'Native image-policy check is running.'
          : policyState.report ? 'Native image-policy check passed.' : 'Native image-policy check awaits a model request or a manual check.';
        const message = forwarding + ' ' + policy
          + (externalKits.includes('traffic-observer') ? traffic?.active() ? ' Traffic observation is enabled.' : ' Traffic observation is off or waiting for its Kit.' : '')
          + (trafficErrors.length ? ' Traffic: ' + trafficErrors.map(error => error.message).join('; ') : '');
        const chinese = (observed ? '已观察到模型请求转发。' : '本地转发已就绪；尚未验证 Codex 路由。')
          + (policyState.error ? ' 原生图片规则检查失败：' + policyState.error.message
            : policyState.running ? ' 正在检查原生图片规则。'
            : policyState.report ? ' 原生图片规则检查通过。' : ' 原生图片规则检查等待模型请求或手动检查。')
          + (externalKits.includes('traffic-observer') ? traffic?.active() ? ' 流量观察已启用。' : ' 流量观察已关闭或正在等待其 Kit。' : '')
          + (trafficErrors.length ? ' 流量：' + trafficErrors.map(error => error.message).join('; ') : '');
        const issues = [...trafficIssues, ...(policyState.error ? [{ key: 'native-policy', message: policyState.error.message }] : [])];
        const traceConflict = trafficErrors.some(error => error.code === 'CDP_TRACE_OWNED' || error.code === -32000 && error.message === 'Tracing has already been started (possibly in another tab).');
        context.setHealth({ ok: !policyState.error && !trafficErrors.length, issueCount: issues.length, issues, message, messageLocales: { en: message, 'zh-Hans': chinese },
          ...(traceConflict ? { recoverable: false } : {}) });
      };
      const diagnostic = entry => { void context.log(entry).catch(error => console.error('Bandwidth diagnostic write failed:', error)); };
      traffic = await createTrafficObserverRouter(externalKits.includes('traffic-observer') ? null : createTrafficService,
        { stateDirectory: context.stateDirectory, cdp: context.cdp, cdpPort: context.cdp?.port, windowsDirectory, connections, powershellPath,
          diagnostic, changed: (errors, issues = errors.map((error, index) => ({ key: String(index), message: error.message }))) => { trafficErrors = errors; trafficIssues = issues; publishHealth(); } });
      let policyAdapter = { discoverDesktopCodex, checkCodexImagePolicy };
      const watcher = createNativePolicyWatcher({
        check: async ({ force, signal }) => {
          const adapter = policyAdapter, runtime = await adapter.discoverDesktopCodex(powershellPath, { signal });
          return adapter.checkCodexImagePolicy({ ...runtime, stateDirectory: path.join(context.stateDirectory, 'native-policy'), force, signal, sharpEntry: adapter.sharpEntry });
        },
        log: entry => context.log(entry),
        changed: state => {
          policyState = state;
          traffic.coverage('native-image-policy', state.error ? 'error' : state.running ? 'info' : state.report ? 'active' : 'info',
            state.error ? state.error.message : state.running ? '正在核对原生图片规则。' : state.report ? '原生图片尺寸和编码规则检查通过。' : '等待原生图片规则检查。');
          publishHealth();
        },
      });
      const log = async entry => {
        traffic.record(entry);
        if (['http-send', 'websocket-send'].includes(entry.event) && /^\/backend-api\/codex\/responses(?:\/compact)?$/.test(entry.path)) {
          observed = true;
          watcher.observe(entry.nativeVersion);
          publishHealth();
        }
        await context.log(entry);
      };
      let service, page;
      try {
        page = await fs.readFile(new URL('../assets/traffic.html', import.meta.url), 'utf8');
        service = await serveImageReferences(context.stateDirectory, { opensslPath, powershellPath, log, externalImageTransform: externalKits.includes('image-reference-dedup') });
      } catch (error) {
        const cleanup = await Promise.allSettled([watcher.close(), traffic.close()]);
        const failures = cleanup.filter(item => item.status === 'rejected').map(item => item.reason);
        if (failures.length) throw new AggregateError([error, ...failures], 'Bandwidth startup and cleanup failed.', { cause: error });
        throw error;
      }
      const { state, proxy } = service;
      let imageReferenceBackendPath = null, imagePolicyBackendPath = null, trafficObserverBackendPath = null;
      publishHealth();
      return {
        check: async () => { await traffic.check(); return watcher.check(); },
        recover: async () => { await traffic.check(); if (policyState.error) await watcher.check(); },
        imageReferenceControl: () => ({ handedOff: externalKits.includes('image-reference-dedup'), backendPath: imageReferenceBackendPath }),
        async setImageReferenceTransform(factory, backendPath) { if (!externalKits.includes('image-reference-dedup')) throw new Error('Image reference deduplication has not been handed off.'); await service.setTransform(factory); imageReferenceBackendPath = backendPath; },
        async disableImageReferenceTransform() { if (!externalKits.includes('image-reference-dedup')) throw new Error('Image reference deduplication has not been handed off.'); await service.disableTransform(); imageReferenceBackendPath = null; },
        imagePolicyControl: () => ({ handedOff: externalKits.includes('image-policy-rules'), stateDirectory: context.stateDirectory, backendPath: imagePolicyBackendPath }),
        trafficObserverControl: () => ({ handedOff: externalKits.includes('traffic-observer'), backendPath: trafficObserverBackendPath }),
        async setTrafficObserver(factory, backendPath) { if (!externalKits.includes('traffic-observer')) throw new Error('Traffic observation has not been handed off.'); try { await traffic.replace(factory); trafficObserverBackendPath = backendPath; } finally { publishHealth(); } },
        async disableTrafficObserver() { if (!externalKits.includes('traffic-observer')) throw new Error('Traffic observation has not been handed off.'); try { await traffic.replace(null); trafficObserverBackendPath = null; } finally { publishHealth(); } },
        async setImagePolicyChecker(adapter, install, backendPath) {
          if (!externalKits.includes('image-policy-rules')) throw new Error('Image policy rules have not been handed off.');
          if (typeof adapter?.discoverDesktopCodex !== 'function' || typeof adapter?.checkCodexImagePolicy !== 'function') throw new TypeError('Invalid image policy checker.');
          await watcher.swap(async () => { await install(); policyAdapter = adapter; }); imagePolicyBackendPath = backendPath;
        },
        async resetImagePolicyChecker(remove) {
          if (!externalKits.includes('image-policy-rules')) throw new Error('Image policy rules have not been handed off.');
          await watcher.swap(async () => { await remove(); policyAdapter = { discoverDesktopCodex, checkCodexImagePolicy }; }); imagePolicyBackendPath = null;
        },
        management: {
          title: { en: 'Bandwidth and traffic', 'zh-Hans': '带宽与流量' },
          async request({ method, url, body }) {
            if (method === 'GET' && url.pathname === '/') return { type: 'text/html; charset=utf-8', body: page };
            if (method === 'GET' && url.pathname === '/api/traffic') {
              const filters = { category: url.searchParams.get('category') ?? '' };
              for (const key of ['from', 'to']) if (url.searchParams.has(key)) filters[key] = Number(url.searchParams.get(key));
              if (codexHome) {
                const rules = await imageIntegrationStatus({ codexHome, stateDirectory: context.stateDirectory });
                traffic.coverage('image-rules', rules.installed ? 'info' : 'gap', rules.installed ? '图片规则已安装；Hook 是否已信任和执行需在原生界面确认。' : '图片规则尚未完整安装。');
              }
              return { body: await traffic.query(filters), headers: url.searchParams.get('download') === '1' ? { 'content-disposition': 'attachment; filename="codex-traffic.json"' } : {} };
            }
            if (method === 'POST' && url.pathname === '/api/traffic-capture') return { body: await traffic.setCapture(body.enabled) };
            return null;
          },
        },
        async close() {
          const results = await Promise.allSettled([watcher.close(), proxy.close()]);
          const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
          // Flush meters produced while the proxy closes before releasing the SQLite owner.
          try { await traffic.close(); } catch (error) { errors.push(error); }
          if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Bandwidth shutdown failed.', { cause: errors[0] });
        },
        launchEnvironment: {
          CODEX_APP_SERVER_OPENAI_BASE_URL: state.baseUrl + 'codex',
          CODEX_CA_CERTIFICATE: state.caPath,
        },
      };
    },
  };
}

export default bandwidthPlugin;
