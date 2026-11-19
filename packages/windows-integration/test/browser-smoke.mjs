import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { kitPayload as createKitPayload } from 'codex-toolkit-core/kits';
// This renderer fixture substitutes for the runtime's service-version preflight.
const kitPayload = (definitions, options = {}) => createKitPayload(definitions, { ...options, serviceVersionChecks: true });
import { windowsPayload } from '../src/payload.mjs';
import readAloudKit from '../kits/markdown-edge-read-aloud/index.mjs';
import updateKit from '../kits/update-restart-protection/index.mjs';

const executable = process.argv[2];
if (!path.isAbsolute(executable ?? '')) throw new Error('Pass the absolute path to an installed Edge executable.');
const directory = path.resolve('Temp', 'browser-smoke-' + randomUUID()); await fs.mkdir(directory, { recursive: true });
const sources = new Map();
for (const filename of ['renderer', 'window-registry', 'window-probe', 'auto-sleep', 'read-aloud-menu', 'update-indicator', 'cloud-unread', 'footer-styles']) sources.set('/' + filename + '.mjs', await fs.readFile(new URL('../src/' + filename + '.mjs', import.meta.url), 'utf8'));
sources.set('/core.mjs', await fs.readFile(new URL(import.meta.resolve('codex-toolkit-core/renderer')), 'utf8'));

const updateFixture = { ...updateKit, helpers: { ...updateKit.helpers, createNativeAssetReader: () => ({}), loadNativeAppServices: async () => window.__CDTK_FIXTURE_UPDATE_SERVICES__ } };
async function checks(readAloudPayload, updatePayload) {
  const results = [], reports = [], actions = [], calls = [];
  const record = (name, passed) => { results.push({ name, passed }); if (!passed) throw new Error(name); };
  const output = value => { const node = document.getElementById('result'); node.setAttribute('data-result', encodeURIComponent(JSON.stringify(value))); node.textContent = JSON.stringify(value); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const helpers = Object.assign({}, ...await Promise.all(['/renderer.mjs', '/window-registry.mjs', '/auto-sleep.mjs', '/read-aloud-menu.mjs', '/update-indicator.mjs', '/cloud-unread.mjs', '/footer-styles.mjs', '/core.mjs'].map(value => import(value))));
    const { installWindowsRenderer, acquireFooter } = helpers;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    window.__CDTK_WINDOWS_BRIDGE__ = value => { const item = JSON.parse(value); (item.kind === 'state' ? reports : actions).push(item); if (item.kind === 'restart-protection') queueMicrotask(() => window.__CODEX_DESKTOP_TOOLKIT_WINDOWS__.resolveRestart(item.requestId, { registered: true, hookInstalled: true, hookVerified: true })); };
    let selectedId = null, menuItems, installs = 0;
    const nativeServices = { appUpdates: { installUpdate() { installs++; } } };
    helpers.createNativeAssetReader = () => ({}); helpers.loadNativeAppServices = async () => nativeServices;
    const cloudIds = ['cloud'], cloudListeners = new Set(); let marks = 0;
    helpers.loadNativeConversationRpc = async () => ({});
    helpers.loadNativeCloudUnread = async () => ({ readState: { read: () => ({ durable: cloudIds }), isReady: () => true,
      subscribe({ listener }) { cloudListeners.add(listener); return () => cloudListeners.delete(listener); } },
      badgeStore: { getSnapshot: () => cloudIds.length, subscribe: () => () => {} },
      markRead() { marks++; cloudIds.length = 0; for (const listener of cloudListeners) listener(); } });
    window.electronBridge = { async showContextMenu(items) { menuItems = items; return selectedId ? { id: selectedId } : null; }, sendMessageFromView(message) {
      calls.push(message);
      const request = message.request;
      const result = request.method === 'thread/read' ? { thread: { id: request.params.threadId, name: 'Upstream ' + request.params.threadId, status: { type: 'idle' } } } : { data: [], nextCursor: null };
      queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'mcp-response', message: { id: request.id, result } } })));
    } };
    const windows = [
      { targetId: 'a', title: '示例窗口-测试🐭', color: 'light-dark(color-mix(in srgb,#12aa34 65%,black),#12aa34)', status: 'idle', unread: false },
      { targetId: 'b', title: 'A long window title with enough characters to require middle truncation', color: '#bb4422', status: 'active', unread: true },
      { targetId: 'c', title: 'Completed', color: '#5522bb', status: 'idle', unread: true },
    ];
    let state = { epoch: 'fixture', targetId: 'a', windows, autoSleep: { enabled: false, error: null }, hostState: { managerUrl: location.origin + '/manager/', health: { plugins: [] } } };
    installWindowsRenderer(window, state, helpers); await settle(); await settle();
    const api = window.__CODEX_DESKTOP_TOOLKIT_WINDOWS__, toolbar = document.getElementById('codex-usage-toolbar'), picker = document.getElementById('cdtk-window-switcher');
    const readId = '00000000-0000-4000-8000-000000000001';
    await api.readSleepActivity('codex_awake', readId);
    const timings = actions.filter(value => value.kind === 'activity-read-timing');
    record('activity stages reach the binding before completion with a shared read ID and no request payloads', timings.length === 4 && timings.every(value => value.readId === readId && value.source === 'codex_awake' && !('params' in value)) && timings.map(value => value.method + ':' + value.status).join(',') === 'thread/loaded/list:started,thread/loaded/list:succeeded,thread/read:started,thread/read:succeeded');
    const originalBinding = window.__CDTK_WINDOWS_BRIDGE__;
    window.__CDTK_WINDOWS_BRIDGE__ = () => { throw new Error('fixture diagnostic delivery failed'); };
    try { record('a broken timing binding preserves a successful activity read', (await api.readSleepActivity('codex_awake', readId)).threadCount === 0); }
    finally { window.__CDTK_WINDOWS_BRIDGE__ = originalBinding; }
    record('Windows installs independently with the Core footer and shared settings', toolbar && document.querySelector('.codex-usage-settings').href === state.hostState.managerUrl);
    const left = toolbar.querySelector('.cdtk-footer-left'), center = toolbar.querySelector('.cdtk-footer-center'), right = toolbar.querySelector('.codex-toolbar-actions');
    const spacer = document.createElement('span'); spacer.style.cssText = 'display:block;width:140px'; left.appendChild(spacer);
    const extraTabs = Array.from({ length: 12 }, () => { const node = document.createElement('span'); node.style.cssText = 'display:block;flex:0 0 180px'; picker.appendChild(node); return node; });
    const bounds = [left, center, right, picker].map(node => node.getBoundingClientRect());
    record('footer slots keep overflowing tabs inside the flexible center without covering either side', getComputedStyle(center).flexGrow === '1' && getComputedStyle(picker).position === 'static' && bounds[0].right <= bounds[1].left + 1 && bounds[1].right <= bounds[2].left + 1 && bounds[3].left >= bounds[1].left - 1 && bounds[3].right <= bounds[1].right + 1 && picker.scrollWidth > picker.clientWidth);
    spacer.remove(); for (const node of extraTabs) node.remove();
    const envelope = document.querySelector('.cdtk-clear-cloud-unread'); envelope.click(); await settle();
    record('cloud unread clear is explicit, event-driven, and stays visible after the badge clears', marks === 1 && !envelope.hidden && !envelope.disabled);
    record('footer reserves 32 pixels below the native app frame', Math.abs(document.querySelector('[data-app-shell-frame]').getBoundingClientRect().height - (innerHeight - 32)) < 1);
    record('native metadata comes from thread/read without a sidebar', reports.at(-1).title === 'Upstream one' && calls.some(value => value.request.method === 'thread/read'));
    record('tabs retain source order and short titles without an ellipsis', picker.children.length === 3 && picker.firstElementChild.firstElementChild.textContent === windows[0].title);
    record('long titles trim only the middle using a fixed text bound', picker.children[1].firstElementChild.textContent.includes('...') && !picker.children[1].firstElementChild.textContent.endsWith('...') && picker.children[1].firstElementChild.getBoundingClientRect().width <= 190);
    record('running takes precedence over unread while the icon slot stays fixed', picker.children[1].querySelector('svg').getAttribute('aria-label') === '正在运行' && picker.children[2].querySelector('svg').getAttribute('aria-label') === '未读' && getComputedStyle(picker.firstElementChild.lastElementChild).width === '16px');
    document.documentElement.style.colorScheme = 'dark';
    const darkTab = getComputedStyle(picker.children[0]).backgroundColor, darkDot = getComputedStyle(picker.children[2].querySelector('circle')).fill;
    document.documentElement.style.colorScheme = 'light';
    const lightTabs = [picker.children[0], picker.children[1]].map(node => getComputedStyle(node).backgroundColor);
    const lightDot = getComputedStyle(picker.children[2].querySelector('circle')).fill;
    document.documentElement.style.setProperty('--cdtk-sidebar', '#ff0000');
    record('light window colors use a stable opaque base and a readable unread dot', lightTabs.every((color, index) => color === getComputedStyle(picker.children[index]).backgroundColor && !color.includes(' / ')) && lightTabs[0] !== darkTab && darkDot === 'rgb(96, 165, 250)' && lightDot === 'rgb(37, 99, 184)');
    document.documentElement.style.colorScheme = 'dark';
    record('tab backgrounds are opaque and do not incorporate footer colors', !getComputedStyle(picker.children[1]).backgroundColor.startsWith('rgba'));
    const button = picker.firstElementChild, mutations = [];
    const observer = new MutationObserver(rows => mutations.push(...rows)); observer.observe(picker, { subtree: true, attributes: true, childList: true, characterData: true });
    api.setState(state); await settle(); mutations.length = 0;
    api.setState(state); button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await settle();
    if (mutations.length) throw new Error('Repeated native DOM writes: ' + JSON.stringify(mutations.map(row => ({ type: row.type, attribute: row.attributeName, target: row.target.outerHTML?.slice(0, 400) }))));
    record('unchanged state and hover neither rebuild nodes nor rewrite attributes', picker.firstElementChild === button && mutations.length === 0); observer.disconnect();
    picker.children[1].click(); record('click requests the exact CDP target, never a window index', actions.at(-1).kind === 'activate' && actions.at(-1).targetId === 'b');
    const moon = document.querySelector('.cdtk-auto-sleep'); record('moon defaults off at ten-percent opacity', moon.getAttribute('aria-pressed') === 'false' && getComputedStyle(moon).opacity === '0.1');
    record('the existing button exposes a unique native automation ID without changing its label', moon.id === 'cdtk-window-a' && moon.getAttribute('aria-label') === '自动睡眠已关闭，点击开启');
    moon.click(); record('click delegates a shared sleep toggle without sleeping locally', actions.at(-1).kind === 'sleep-toggle' && actions.at(-1).enabled === true);
    state = { ...state, autoSleep: { enabled: true, error: null } }; api.setState(state);
    record('a shared state push lights the moon immediately', moon.getAttribute('aria-pressed') === 'true' && getComputedStyle(moon).opacity === '1');
    document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id', 'two'); await settle(); await settle();
    record('changing current chat refreshes its upstream title without polling', reports.at(-1).taskKey === 'local:two' && reports.at(-1).title === 'Upstream two');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'mcp-notification', hostId: 'local', method: 'turn/started', params: { threadId: 'two', turn: { id: 'turn-two' } } } }));
    record('native lifecycle events update running state and the shared controller', reports.at(-1).status === 'active' && actions.at(-1).kind === 'activity');
    const installButton = document.createElement('button'); installButton.textContent = 'Install update';
    installButton.__reactFiber$fixture = { type: function Update() { return { id: 'appHeader.installUpdate' }; } };
    installButton.onclick = nativeServices.appUpdates.installUpdate; document.querySelector('main').appendChild(installButton); await settle(); await settle();
    record('verified native restart guard lights the green dot without changing the official click handler', installButton.getAttribute('data-cdt-hosted-update') === 'active' && installButton.onclick === nativeServices.appUpdates.installUpdate && getComputedStyle(installButton, '::after').backgroundColor === 'rgb(34, 197, 94)');
    installButton.click(); record('official update click executes exactly its existing method', installs === 1);
    let nativeSelections = 0;
    const provider = { getItems: () => [{ id: 'native-open', label: 'Open', onSelect() { nativeSelections++; } }, { id: 'native-copy', label: 'Copy path', onSelect() { nativeSelections++; } }] };
    const link = document.createElement('a'); link.textContent = 'doc.md'; link.dataset.fileReference = 'true'; link.dataset.promptLinkHref = 'C:/work/doc.md'; link.__reactFiber$fixture = { memoizedProps: provider }; document.querySelector('main').appendChild(link);
    const contextMenu = element => { const event = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true }); element.dispatchEvent(event); return event; };
    selectedId = 'native-copy'; contextMenu(link); await settle();
    record('chat Markdown context menu keeps all native items and their callbacks', menuItems.map(item => item.id).join(',') === 'native-open,native-copy,cdtk-read-aloud-separator,cdtk-read-aloud' && nativeSelections === 1);
    selectedId = 'cdtk-read-aloud'; contextMenu(link); await settle();
    record('chat read-aloud action sends the exact path once', actions.at(-1).kind === 'read-aloud' && actions.at(-1).path === 'C:/work/doc.md');
    const tree = document.createElement('file-tree-container'), shadow = tree.attachShadow({ mode: 'open' });
    let originalCalls = 0;
    const original = () => { void 'showContextMenu pointercancel'; originalCalls++; }, ref = { current: original };
    tree.__reactFiber$fixture = { memoizedProps: { ...provider, cwd: 'C:/work' }, memoizedState: { memoizedState: ref } };
    shadow.innerHTML = '<span data-item-type="file" data-item-path="folder/doc.md">doc.md</span>'; document.querySelector('main').appendChild(tree); await settle(); await settle();
    const treeFile = shadow.firstElementChild, event = contextMenu(treeFile); await ref.current(event); await settle();
    record('shadow file tree gains read-aloud beside original menu items with its own workspace path', menuItems[0].id === 'native-open' && menuItems.at(-1).id === 'cdtk-read-aloud' && actions.at(-1).path === 'C:/work/folder/doc.md' && originalCalls === 0);
    treeFile.dataset.itemPath = 'file.txt'; await ref.current(contextMenu(treeFile)); record('non-Markdown tree files retain the untouched original context handler', originalCalls === 1);
    const annotation = document.querySelector('[data-above-composer-conversation-id]'); annotation.__reactFiber$fixture = { memoizedProps: { value: { location: { pathname: '/local/two', search: '?hostId=durable' } } } };
    annotation.setAttribute('data-above-composer-conversation-id', 'durable:two'); await settle(); await settle();
    record('nonlocal metadata preserves its actual host', reports.at(-1).taskKey === 'durable:two' && calls.at(-1).hostId === 'durable');
    annotation.remove(); document.querySelector('main').__reactFiber$fixture = { memoizedProps: { value: { location: { pathname: '/dots/example' } } } };
    document.title = 'Example cloud task'; await settle(); await settle();
    record('Dot is managed by its window without fabricating a local thread', reports.at(-1).taskKey === null && reports.at(-1).title === 'Example cloud task');
    document.title = 'Renamed Dot'; await settle(); await settle();
    record('Dot title changes are observed without polling', reports.at(-1).title === 'Renamed Dot');
    window.__CDTK_TEST_KIT_ACTION__ = value => { const item=JSON.parse(value);if(item.kind!=='feature-health')actions.push(item); };
    let refused=false;try{await (0,eval)(readAloudPayload);}catch(error){refused=error.message.includes('has not handed off');}
    record('standalone read aloud refuses an existing unhanded legacy owner',refused&&ref.current!==original);
    const other = acquireFooter(document, 'another-plugin', state.hostState), sentinel = document.createElement('span'); sentinel.id = 'other-plugin-content'; other.left.appendChild(sentinel);
    api.cleanup(); record('cleanup preserves another plugin footer and its reserved height', document.getElementById('other-plugin-content') && document.getElementById('codex-usage-toolbar') && !document.querySelector('#cdtk-window-switcher,.cdtk-auto-sleep,#cdtk-windows-style'));
    record('cleanup restores only the owned tree handler and removes the update marker', ref.current === original && !installButton.hasAttribute('data-cdt-hosted-update'));
    record('cleanup removes the cloud control and subscription', !document.querySelector('.cdtk-clear-cloud-unread') && cloudListeners.size === 0);
    other.release(); record('the final owner release removes only the shared footer and its layout class', !document.getElementById('codex-usage-toolbar') && !document.documentElement.classList.contains('codex-usage-toolbar-active') && document.getElementById('native-style'));
    record('no unexpected renderer error is hidden', reports.every(value => value.errors.length === 0));
    state={...state,epoch:'read-aloud-handoff',externalFooter:true,externalKits:['markdown-edge-read-aloud','update-restart-protection']};
    installWindowsRenderer(window,state,helpers);await settle();
    record('legacy Windows hands off the Markdown menu',ref.current===original);
    record('legacy Windows hands off update protection without changing the button',!installButton.hasAttribute('data-cdt-hosted-update')&&installButton.onclick===nativeServices.appUpdates.installUpdate);
    await (0,eval)(readAloudPayload);await settle();
    const kitHost=window.__CODEXTOPKITS_FEATURE_HOST__;
    selectedId='native-copy';contextMenu(link);await settle();
    record('standalone Markdown Kit preserves the native chat menu and callbacks',menuItems.map(item=>item.id).join(',')==='native-open,native-copy,cdtk-read-aloud-separator,cdtk-read-aloud'&&nativeSelections===2);
    selectedId='cdtk-read-aloud';contextMenu(link);await settle();
    record('standalone Markdown Kit forwards the selected chat path',actions.at(-1).kind==='read-aloud'&&actions.at(-1).path==='C:/work/doc.md');
    treeFile.dataset.itemPath='folder/doc.md';await ref.current(contextMenu(treeFile));await settle();
    record('standalone Markdown Kit adds the action to the native file tree menu',menuItems.at(-1).id==='cdtk-read-aloud'&&actions.at(-1).path==='C:/work/folder/doc.md');
    await kitHost.close();record('stopping Markdown Kit restores the native tree handler',ref.current===original);
    delete window.__CODEXTOPKITS_FEATURE_HOST__;
    window.__CDTK_FIXTURE_UPDATE_SERVICES__=nativeServices;
    await (0,eval)(updatePayload);await settle();const updateHost=window.__CODEXTOPKITS_FEATURE_HOST__;
    const firstRegistration=actions.findLast(value=>value.kind==='restart-protection');
    record('standalone update protection waits for verification without changing the official handler',Boolean(firstRegistration)&&!installButton.hasAttribute('data-cdt-hosted-update')&&installButton.onclick===nativeServices.appUpdates.installUpdate);
    window.__CODEXTOPKITS_RESTART_PROTECTION__.resolve(firstRegistration.requestId,{registered:true,hookInstalled:true,hookVerified:false},null);await settle();
    record('an unverified standalone guard never lights the green dot',!installButton.hasAttribute('data-cdt-hosted-update')&&updateHost.snapshot()[0].error?.message.includes('not confirmed'));
    await updateHost.close();delete window.__CODEXTOPKITS_FEATURE_HOST__;
    await (0,eval)(updatePayload);await settle();const secondRegistration=actions.findLast(value=>value.kind==='restart-protection');
    window.__CODEXTOPKITS_RESTART_PROTECTION__.resolve(secondRegistration.requestId,{registered:true,hookInstalled:true,hookVerified:true},null);await settle();
    record('verified standalone protection lights green without replacing the official update action',installButton.getAttribute('data-cdt-hosted-update')==='active'&&installButton.onclick===nativeServices.appUpdates.installUpdate&&getComputedStyle(installButton,'::after').backgroundColor==='rgb(34, 197, 94)');
    const beforeInstall=installs;installButton.click();record('the official update method remains the sole click action',installs===beforeInstall+1);
    await window.__CODEXTOPKITS_FEATURE_HOST__.close();record('stopping update protection removes only its marker',!installButton.hasAttribute('data-cdt-hosted-update')&&installButton.onclick===nativeServices.appUpdates.installUpdate);
    window.__CODEX_DESKTOP_TOOLKIT_WINDOWS__.cleanup();
    const {installWindowProbe}=await import('/window-probe.mjs');window.__CDTK_TEST_WINDOW_ACTION__=value=>actions.push(JSON.parse(value));installWindowProbe(window,'probe','__CDTK_TEST_WINDOW_ACTION__',helpers);
    window.dispatchEvent(new MessageEvent('message',{data:{type:'mcp-notification',hostId:'local',method:'turn/completed',params:{threadId:'one',turn:{id:'done',status:'interrupted',items:['private output']}}}}));
    const lifecycle=actions.findLast(value=>value.kind==='window-activity');record('shared window probe carries terminal status but no output content',lifecycle.params.turnId==='done'&&lifecycle.params.turnStatus==='interrupted'&&!JSON.stringify(lifecycle).includes('private output'));window.__CODEXTOPKITS_WINDOW_PROBE__.close();
    output({ ok: true, checks: results, observedAt: new Date().toISOString() });
  } catch (error) { output({ ok: false, checks: results, error: { name: error.name, message: error.message, stack: error.stack }, reports: reports.slice(-3) }); }
}
const html = '<!doctype html><html><title>Fixture</title><meta charset="utf-8"><style id="native-style">:root{--codex-chat-font-size:16px}*{box-sizing:border-box}body{margin:0}[data-app-shell-frame]{height:100vh}main{height:100%;background:#222}[data-codex-composer-root]{height:120px}#result{position:absolute;top:20px}</style><body><div id="root"><div data-app-shell-frame="true"><main class="main-surface"><div data-codex-composer-root><span data-above-composer-conversation-id="one"></span></div></main></div></div><pre id="result">running</pre><script type="module">(' + checks.toString() + ')(' + JSON.stringify(kitPayload([readAloudKit], { bindingName: '__CDTK_TEST_KIT_ACTION__' })) + ',' + JSON.stringify(kitPayload([updateFixture], { bindingName: '__CDTK_TEST_KIT_ACTION__' })) + ');</script></body></html>';
const server = http.createServer((request, response) => {
  if (sources.has(request.url)) { response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(sources.get(request.url), 'utf8'); }
  else if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html, 'utf8'); }
  else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const { stdout, stderr } = await promisify(execFile)(executable, ['--headless=new', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(directory, 'profile'), '--dump-dom', '--virtual-time-budget=10000', 'http://127.0.0.1:' + server.address().port], { windowsHide: true, encoding: 'utf8', maxBuffer: 3 * 1024 * 1024, timeout: 60000 });
  await fs.writeFile(path.join(directory, 'dom.html'), stdout, 'utf8'); await fs.writeFile(path.join(directory, 'stderr.log'), stderr, 'utf8');
  const match = stdout.match(/<pre\b[^>]*\bid="result"[^>]*\bdata-result="([^"]+)"/); assert.ok(match, 'Browser checks did not finish; inspect ' + directory);
  const result = JSON.parse(decodeURIComponent(match[1])); await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  assert.equal(result.ok, true, JSON.stringify(result)); new vm.Script(windowsPayload({ epoch: 'syntax' }));
  console.log(JSON.stringify({ ok: true, checks: result.checks.length, directory, observedAt: new Date().toISOString() }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
