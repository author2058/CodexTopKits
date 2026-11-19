// Serialized into the renderer. Follow the application's real bootstrap chain.
export function acquireFooter(document, owner, hostState, { managerEntry = true } = {}) {
  const window = document.defaultView, key = '__CODEX_DESKTOP_TOOLKIT_FOOTER__';
  let shared = window[key];
  if (!shared) {
    if (document.getElementById('codex-usage-toolbar')) throw new Error('底栏已被其他控制器占用。');
    const style = document.createElement('style'); style.id = 'cdtk-footer-style'; style.setAttribute('data-cdtk-owned', 'footer');
    const baseCss = 'html.codex-usage-toolbar-active{--codex-usage-toolbar-height:32px}html.codex-usage-toolbar-active #root>div.relative.flex.flex-col,html.codex-usage-toolbar-active #root [data-app-shell-frame="true"]{height:calc((100dvh - var(--codex-usage-toolbar-height))/var(--codex-window-zoom,1))!important;max-height:calc((100dvh - var(--codex-usage-toolbar-height))/var(--codex-window-zoom,1))!important}#codex-usage-toolbar{position:fixed;z-index:45;right:0;bottom:0;left:0;display:flex;height:var(--codex-usage-toolbar-height);align-items:center;justify-content:space-between;padding:0 14px;pointer-events:none;border-top:1px solid color-mix(in srgb,var(--color-token-border-light,light-dark(#cbd0d8,#4b5563)) 65%,transparent);background:var(--cdtk-sidebar,var(--color-token-main-surface-primary,light-dark(#fff,#10131b)));color:var(--color-token-text-secondary,light-dark(#555e6b,#aab4c4));font-family:"Segoe UI Variable",system-ui,sans-serif;font-size:var(--codex-chat-font-size,var(--text-base,13px));font-weight:400;line-height:1.2;letter-spacing:.01em}#codex-usage-toolbar .codex-toolbar-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto}#codex-usage-toolbar[data-codex-usage-state="ready"]{color:var(--color-token-foreground,light-dark(#1a1c1f,#dce3ee))}';
    const slotsCss = '#codex-usage-toolbar .cdtk-footer-left,#codex-usage-toolbar .codex-toolbar-actions{flex:0 0 auto}#codex-usage-toolbar .cdtk-footer-center{display:flex;flex:1 1 auto;min-width:0;height:100%;align-items:center;justify-content:center}';
    style.textContent = baseCss + slotsCss;
    const element = document.createElement('div'); element.id = 'codex-usage-toolbar'; element.setAttribute('data-cdtk-owned', 'footer');
    const left = document.createElement('span'), center = document.createElement('span'), right = document.createElement('span');
    left.className = 'cdtk-footer-left'; center.className = 'cdtk-footer-center'; right.className = 'codex-toolbar-actions'; element.append(left, center, right);
    let settings = null;
    const acknowledgedIssues = new Set(); let currentIssues = new Set();
    const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
    const attribute = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
    shared = { element, left, center, right, owners: new Set(), hostState: null,
      mountManager(formatTitle) {
        if (settings) throw new Error("The footer manager entry already has an owner.");
        settings = document.createElement("a"); settings.className = "codex-usage-settings"; settings.target = "_blank"; settings.rel = "noopener noreferrer";
        settings.setAttribute("data-cdtk-owned", "manager-entry");
        settings.onclick = event => {
          for (const key of currentIssues) acknowledgedIssues.add(key);
          shared.setHostState(shared.hostState);
          if (!shared.hostState?.managerUrl) event.preventDefault();
        };
        right.appendChild(settings); style.textContent = baseCss + slotsCss + '#codex-usage-toolbar .codex-usage-settings{display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:32px;margin-right:-6px;pointer-events:auto;color:inherit;text-decoration:none;font-size:1em;line-height:1;order:100}#codex-usage-toolbar .codex-usage-settings:hover{color:var(--color-token-foreground,light-dark(#1a1c1f,#dce3ee))}#codex-usage-toolbar .codex-usage-settings[data-codex-health="error"]{box-sizing:border-box;min-width:1.25em;height:1.25em;padding:0 .3em;border-radius:999px;background:light-dark(#b42318,#e5484d);color:#fff!important;font-weight:600;text-shadow:none}#codex-usage-toolbar .codex-usage-settings[data-codex-health="error"]:hover{background:light-dark(#912018,#f45b60);color:#fff!important}';
        shared.formatManagerTitle = formatTitle;
        shared.setHostState(shared.hostState);
        const owned = settings;
        return { refresh() { if (settings === owned) shared.setHostState(shared.hostState); }, close() { if (settings !== owned) return; settings.remove(); settings = null; shared.formatManagerTitle = null; style.textContent = baseCss + slotsCss; } };
      },
      setHostState(value) {
        shared.hostState = value;
        if (!settings) return;
        attribute(settings, 'href', value?.managerUrl || '#');
        const count = value?.health?.plugins?.reduce((sum, plugin) => sum + (plugin.ok ? 0 : plugin.issueCount ?? 1), 0) || 0;
        currentIssues = new Set((value?.health?.plugins || []).flatMap(plugin => (plugin.issues || (!plugin.ok ? [{ key: '', message: plugin.message || '' }] : []))
          .map(issue => JSON.stringify([plugin.id, issue.key, issue.message]))));
        for (const key of acknowledgedIssues) if (!currentIssues.has(key)) acknowledgedIssues.delete(key);
        const notify = count > 0 && [...currentIssues].some(key => !acknowledgedIssues.has(key));
        const title = shared.formatManagerTitle ? shared.formatManagerTitle(count) : count ? '发现 ' + count + ' 项问题，点击查看详情' : '打开工具设置';
        attribute(settings, 'data-codex-health', notify ? 'error' : 'ok'); attribute(settings, 'data-codex-error-count', String(count));
        attribute(settings, 'title', title); attribute(settings, 'aria-label', title); text(settings, notify ? String(count) : String.fromCodePoint(0x2699));
      },
      destroy() { element.remove(); style.remove(); document.documentElement.classList.remove('codex-usage-toolbar-active'); delete window[key]; },
    };
    if (managerEntry) shared.mountManager();
    document.head.appendChild(style); document.body.appendChild(element); document.documentElement.classList.add('codex-usage-toolbar-active'); window[key] = shared;
  }
  if (shared.owners.has(owner)) throw new Error('Duplicate footer owner: ' + owner);
  shared.owners.add(owner); shared.setHostState(hostState);
  let released = false;
  return { element: shared.element, left: shared.left, center: shared.center, right: shared.right, setHostState: shared.setHostState, mountManager: shared.mountManager,
    release() { if (released) return; released = true; shared.owners.delete(owner); if (!shared.owners.size) shared.destroy(); },
  };
}

export function readNativeNotification(data) {
  if (data?.type !== 'mcp-notification') return null;
  const notification = data.notification ?? data;
  if (typeof notification.method !== 'string' || !notification.method || !notification.params || typeof notification.params !== 'object' || Array.isArray(notification.params)) {
    throw new TypeError('Native conversation notification shape changed.');
  }
  return notification;
}

export function createNativeBridgeClient(window) {
  const pending = new Map();
  let closed = false, listening = false;
  const finish = (id, error, value) => {
    const item = pending.get(id); if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    if (!pending.size && listening) { window.removeEventListener('message', receive); listening = false; }
    error ? item.reject(error) : item.resolve(value);
  };
  const receive = event => {
    if (event.source && event.source !== window) return;
    const value = event.data, id = value?.requestId ?? value?.message?.id, item = pending.get(id);
    if (!item) return;
    if (value.type !== item.expected) { finish(id, new TypeError('Native bridge response type changed: ' + value.type)); return; }
    finish(id, null, value);
  };
  const request = (message, expected, id, timeoutMs = 5000) => {
    if (closed) return Promise.reject(new Error('Native bridge client stopped.'));
    if (typeof id !== 'string' || !id || typeof expected !== 'string' || !expected || pending.has(id)) return Promise.reject(new TypeError('Invalid or duplicate native bridge request identity.'));
    if (typeof window.electronBridge?.sendMessageFromView !== 'function') return Promise.reject(new Error('Electron 消息桥不可用。'));
    return new Promise((resolve, reject) => {
      const item = { expected, resolve, reject, timer: setTimeout(() => finish(id, new Error(expected + ' timed out.')), timeoutMs) };
      pending.set(id, item);
      if (!listening) { window.addEventListener('message', receive); listening = true; }
      try { Promise.resolve(window.electronBridge.sendMessageFromView(message)).catch(error => finish(id, error)); }
      catch (error) { finish(id, error); }
    });
  };
  return {
    request,
    async appServer(method, params, { hostId = 'local', source = 'codex_toolkit', timeoutMs = 5000 } = {}) {
      const id = 'cdtk-native-' + window.crypto.randomUUID();
      const response = await request({ type: 'mcp-request', hostId, request: { id, method, params }, priority: 'background', source, timeoutMs }, 'mcp-response', id, timeoutMs);
      const message = response.message;
      if (message?.error) throw Object.assign(new Error(message.error.message || method + ' failed.', { cause: message.error }), { code: message.error.code, data: message.error.data });
      if (!message || !Object.hasOwn(message, 'result')) throw new TypeError('Native app-server response has no result: ' + method);
      return message.result;
    },
    close() { closed = true; for (const id of pending.keys()) finish(id, new Error('Native bridge client stopped.')); },
  };
}

export function createNativeAssetReader(document, { fetchModule = globalThis.fetch, importModule = url => import(url) } = {}) {
  const entryUrl = [...document.scripts].find(script => /\/assets\/index-[^/]+\.js$/.test(script.src))?.src;
  const pending = new Map(), resolved = new Map(), owners = new Map();
  let entrySource, runtimePromise, runtimeUrl;
  const read = url => {
    if (pending.has(url)) return pending.get(url);
    const request = (async () => {
      const response = await fetchModule(url);
      if (!response.ok) throw new Error('Native assets: module HTTP ' + response.status + ' (' + url + ')');
      return response.text();
    })().finally(() => pending.delete(url));
    pending.set(url, request); return request;
  };
  const resolve = prefix => {
    if (resolved.has(prefix)) return resolved.get(prefix);
    const request = (async () => {
      if (!entryUrl) throw new Error('Native assets: renderer entry is unavailable.');
      const reference = source => source.match(new RegExp(prefix + '-[A-Za-z0-9_-]+\\.js'))?.[0];
      const entry = await (entrySource ||= read(entryUrl).catch(error => { entrySource = null; throw error; }));
      let parent = entryUrl, name = reference(entry);
      if (!name && prefix === 'app-initial') {
        const main = entry.match(/app-main-[A-Za-z0-9_-]+\.js/)?.[0];
        if (main) { parent = new URL(main, entryUrl).href; name = reference(await read(parent)); }
      }
      return name ? new URL(name, parent).href : null;
    })().catch(error => { if (resolved.get(prefix) === request) resolved.delete(prefix); throw error; });
    resolved.set(prefix, request); return request;
  };
  const runtime = () => runtimePromise ||= (async () => {
    if (entryUrl) return null;
    for (const script of [...document.scripts].reverse()) {
      if (script.type !== 'module' || !/\/assets\/[^/]+\.js$/.test(script.src)) continue;
      const module = await importModule(script.src), require = module.__webpack_require__;
      if (typeof require === 'function' && require.m && require.c) { runtimeUrl = script.src; return require; }
    }
    throw new Error('Native assets: renderer module runtime is unavailable.');
  })().catch(error => { runtimePromise = null; throw error; });
  const find = (name, matches) => {
    if (owners.has(name)) return owners.get(name);
    const request = (async () => {
      const require = await runtime();
      if (!require) return null;
      const candidates = [];
      for (const [id, factory] of Object.entries(require.m)) {
        const source = Function.prototype.toString.call(factory);
        if (matches(source)) candidates.push({ id, source });
      }
      if (candidates.length !== 1) throw new Error('Native assets: ' + name + ' has ' + candidates.length + ' matching modules; expected one.');
      const { id, source } = candidates[0];
      return { id, source, url: runtimeUrl + '#module=' + id, load: () => require(id) };
    })().catch(error => { if (owners.get(name) === request) owners.delete(name); throw error; });
    owners.set(name, request); return request;
  };
  return { entryUrl, read, resolve, runtime, find };
}

export async function loadNativeAppServices(document, { assets = createNativeAssetReader(document), importModule = url => import(url) } = {}) {
  const owner = await assets.find('app services', source => source.includes('setAppServices:') && source.includes('appServices:'));
  let module;
  if (owner) module = owner.load();
  else {
    const url = await assets.resolve('rpc');
    if (!url) throw new Error('Native app services: RPC module reference changed.');
    module = await importModule(url);
  }
  if (!module.appServices || typeof module.appServices !== 'object') throw new Error('Native app services export is unavailable.');
  return module.appServices;
}

export function readNativeConversationIdentity(document) {
  const win = document.defaultView;
  const annotation = [...document.querySelectorAll('[data-above-composer-conversation-id]')].find(element => {
    if (element.closest('[role="tabpanel"]')) return false;
    const owner = element.closest('[data-codex-composer-root]') || element.closest('[class*="_Workspace_"]') || element.closest('main');
    return owner?.getClientRects().length && win.getComputedStyle(owner).visibility !== 'hidden';
  });
  if (!annotation) {
    const main = [...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].find(element => element.getClientRects?.().length);
    let fiber = main?.[Object.keys(main).find(key => key.startsWith('__reactFiber$'))];
    const seen = new Set();
    while (fiber && !seen.has(fiber)) {
      seen.add(fiber);
      const pathname = fiber.memoizedProps?.value?.location?.pathname;
      if (typeof pathname === 'string') { if (pathname.startsWith('/dots/')) return null; break; }
      fiber = fiber.return;
    }
  }
  const active = document.querySelector('[data-app-action-sidebar-thread-active="true"][aria-current="page"]');
  const value = annotation?.getAttribute('data-above-composer-conversation-id') || active?.getAttribute('data-app-action-sidebar-thread-id');
  if (!value) return null;
  const text = value.trim(), split = text.lastIndexOf(':'), threadId = text.slice(split + 1);
  const seed = win.electronBridge?.getInitialSidebarBootstrap?.()?.catalogEntries?.find(entry => entry.threadId === threadId);
  let hostId = split < 0 ? null : text.slice(0, split);
  if (!hostId && annotation) {
    let fiber = annotation[Object.keys(annotation).find(key => key.startsWith('__reactFiber$'))];
    const seen = new Set();
    while (fiber && !seen.has(fiber)) {
      seen.add(fiber);
      const location = fiber.memoizedProps?.value?.location;
      if (location?.pathname === '/local/' + threadId) {
        hostId = new URLSearchParams(location.search).get('hostId') || 'local';
        break;
      }
      fiber = fiber.return;
    }
  }
  const activeKey = active?.getAttribute('data-app-action-sidebar-thread-id');
  if (!hostId && activeKey?.includes(':') && activeKey.split(':').at(-1) === threadId) hostId = activeKey.slice(0, activeKey.lastIndexOf(':'));
  hostId ||= seed?.hostId || 'local';
  return { taskKey: hostId + ':' + threadId, threadId, hostId, seed };
}

export async function loadNativeConversationRpc(document, { assets = createNativeAssetReader(document), importModule = url => import(url) } = {}) {
  const marker = 'AppServerManager RPC is unavailable for hostId:';
  const owner = await assets.find('conversation RPC registry', source => source.includes(marker) && source.includes('.forHost('));
  let moduleUrl = owner?.url, source = owner?.source, module, signal;
  for (const prefix of owner ? [] : ['app-shared', 'app-initial']) {
    const url = await assets.resolve(prefix);
    if (!url) continue;
    const candidate = await assets.read(url);
    if (candidate.includes(marker)) { moduleUrl = url; source = candidate; break; }
  }
  if (!moduleUrl) throw new Error('Native conversation RPC: manager registry module changed.');
  if (owner) {
    module = owner.load();
    const signals = Object.values(module).filter(value => value?.scope && typeof value.resolve === 'function');
    if (signals.length !== 1) throw new Error('Native conversation RPC: manager registry export changed.');
    signal = signals[0];
  } else {
    module = await importModule(moduleUrl);
    const index = source.indexOf(marker), accessor = source.slice(source.lastIndexOf('function ', index), index);
    const name = accessor.match(/,\w+=\w+\.get\((\w+)\);if\(\w+!=null/)?.[1];
    if (!name) throw new Error('Native conversation RPC: manager registry accessor changed.');
    const exported = source.slice(source.lastIndexOf('export{')).match(new RegExp('\\b' + name + ' as (\\w+)'))?.[1];
    signal = module[exported];
  }
  if (!signal?.scope || typeof signal.resolve !== 'function') throw new Error('Native conversation RPC: manager registry export changed.');
  const root = document.getElementById('root'), key = root && Object.getOwnPropertyNames(root).find(name => name.startsWith('__reactContainer$'));
  const container = key && root[key], pending = [container?.stateNode?.current || container], seen = new Set();
  let registry;
  while (pending.length && !registry) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    const chain = fiber.memoizedProps?.value;
    if (chain instanceof Map && chain.has(signal.scope.id)) {
      const node = chain.get(signal.scope.id);
      registry = node.store.get(signal.resolve(node, chain));
    }
    if (fiber.child) pending.push(fiber.child);
    if (fiber.sibling) pending.push(fiber.sibling);
  }
  if (typeof registry?.forHost !== 'function') throw new Error('Native conversation RPC: manager registry is unavailable.');
  return { moduleUrl, forHost: hostId => registry.forHost(hostId) };
}
