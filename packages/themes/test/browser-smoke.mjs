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
import { themePayload } from '../src/payload.mjs';
import { resolveTheme, validateMap } from '../src/model.mjs';
import fontKit from '../kits/ui-font-size/index.mjs';
import colorKit from '../kits/project-thread-colors/index.mjs';
import profileKit from '../kits/profile-panel-shadow/index.mjs';
import { createLocalization } from '../../core/src/localization.mjs';
import { createManagementI18n } from '../../core/src/management-localization.mjs';

const executable = process.argv[2];
if (!path.isAbsolute(executable ?? '')) throw new Error('Pass the absolute path to an installed Edge executable.');
const root = path.resolve('Temp', 'browser-smoke-' + randomUUID());
await fs.mkdir(root, { recursive: true });
const initial = JSON.parse(await fs.readFile(new URL('../assets/theme-map.json', import.meta.url), 'utf8'));
const map = { ...initial, uiFontSizeOverride: 20, projects: { Alpha: 'red', Beta: 'blue' } };
const manager = await fs.readFile(new URL('../assets/theme-manager.html', import.meta.url), 'utf8');
new vm.Script(manager.match(/<script>([\s\S]*?)<\/script>/)[1], { filename: 'theme-manager-inline.js' });

const nativeModule = `
  const fixture = window.fixture = {
    projects: { a: {id:'a',name:'Alpha',rootPaths:['S:/fixtures/Alpha']}, b: {id:'b',name:'Beta',rootPaths:['S:/fixtures/Beta']} },
    assignments: {one:'a',two:'b'},
    threads: {one:{id:'one',name:'First',projectId:'a',cwd:'S:/fixtures/Alpha'},two:{id:'two',name:'Second',projectId:'b',cwd:'S:/fixtures/Beta'}},
    hold:false,pending:[],reads:0,
    release(){for(const reply of this.pending.splice(0))reply();},
    navigate(id){document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id',id);document.getElementById('project').setAttribute('aria-label','Project: '+(id==='one'?'Alpha':'Beta'));}
  };
  const services = {projectCatalog:{async readLocalProjects(){return structuredClone(fixture.projects);}},threadProjectAssignments:{async readMemberships(){return {assignments:structuredClone(fixture.assignments)};}}};
  function require(){return {appServices:services};}
  require.m={services:function(){return {setAppServices:null,appServices:null};}};require.c={};
  export {require as __webpack_require__};
  window.electronBridge={
    getInitialSidebarBootstrap(){return {globalStateEntries:[{key:'local-projects',value:fixture.projects},{key:'thread-project-assignments',value:fixture.assignments}],catalogEntries:Object.values(fixture.threads).map(thread=>({hostId:'local',threadId:thread.id,displayTitle:thread.name,cwd:thread.cwd}))};},
    sendMessageFromView(message){
      if(message.type!=='mcp-request'||message.request.method!=='thread/read')throw new Error('Unexpected native request');
      fixture.reads++;
      const thread=structuredClone(fixture.threads[message.request.params.threadId]);
      const reply=()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcp-response',message:{id:message.request.id,result:{thread,readState:{}}}}}));
      if(fixture.hold){fixture.pending.push(reply);window.dispatchEvent(new Event('fixture-request'));}else queueMicrotask(reply);
    }
  };
`;

async function browserChecks(map, payload, externalPayload, fontPayload, colorExternalPayload, colorPayload, bothExternalPayload, bothPayload, shadowExternalPayload, shadowPayload) {
  const checks = [], reports = [], waiting = [];
  const record = (name, passed) => { checks.push({ name, passed }); if (!passed) throw new Error(name); };
  const next = predicate => {
    const current = reports.at(-1); if (current && predicate(current)) return Promise.resolve(current);
    return new Promise(resolve => waiting.push({ predicate, resolve }));
  };
  const output = value => { const pre=document.getElementById('result');pre.textContent=JSON.stringify(value);pre.setAttribute('data-result',encodeURIComponent(JSON.stringify(value))); };
  try {
    await import('/assets/main.fixture.js');
    window.__CDTK_THEMES_REPORT__ = value => {
      const report=JSON.parse(value);reports.push(report);
      for(let index=waiting.length-1;index>=0;index--)if(waiting[index].predicate(report)){waiting[index].resolve(report);waiting.splice(index,1);}
    };
    window.eval(payload);
    const api=window.__CODEX_DESKTOP_TOOLKIT_THEMES__;
    await next(report=>report.context?.source==='app-server'&&report.context.taskKey==='local:one');
    const css=selector=>getComputedStyle(document.querySelector(selector));
    const profile=document.createElement('div');profile.id='profile-fixture';profile.className='w-57 rounded-2xl';profile.setAttribute('role','menu');profile.setAttribute('data-radix-menu-content','');profile.setAttribute('data-side','right');profile.setAttribute('data-align','end');document.body.appendChild(profile);
    const originalShadow=css('#profile-fixture').boxShadow;
    record('existing profile panel has an outline and shadow',originalShadow!=='none');
    record('native preload replies with source=null hydrate successfully',reports.at(-1).errors.length===0);
    record('project color reaches the main content',css('#main').backgroundColor==='rgb(50, 25, 35)');
    const colorReference=document.createElement('span');document.body.appendChild(colorReference);
    colorReference.style.background='color-mix(in srgb,#ef5c70 24%,transparent)';
    record('dark selected background retains the original accent mix',css('#sidebar [aria-current="page"]').backgroundColor===getComputedStyle(colorReference).backgroundColor);
    record('dark accent retains the original value',document.documentElement.style.getPropertyValue('--cdtk-accent')==='#ef5c70');
    document.documentElement.style.colorScheme='light';
    const lightSurface=css('#main').backgroundColor;
    colorReference.style.background='color-mix(in srgb,#ef5c70 30%,white)';
    record('light project surface uses 30% original accent and reaches shared consumers',lightSurface===getComputedStyle(colorReference).backgroundColor&&css('#consumer').backgroundColor===lightSurface&&css('#right-main').backgroundColor==='rgb(36, 36, 36)');
    colorReference.style.background='color-mix(in srgb,#ef5c70 40%,white)';
    record('light selection uses 40% original accent',css('#sidebar [aria-current="page"]').backgroundColor===getComputedStyle(colorReference).backgroundColor);
    record('light accent retains the original value',document.documentElement.style.getPropertyValue('--cdtk-accent')==='#ef5c70');
    record('light selection text remains dark',css('#sidebar [aria-current="page"]').color==='rgb(26, 28, 31)');
    record('profile menu shadow adapts to light',css('#profile-fixture').boxShadow!=='none'&&css('#profile-fixture').boxShadow!==originalShadow);
    document.documentElement.style.colorScheme='dark';
    colorReference.remove();
    record('returning to dark restores the original project color',css('#main').backgroundColor==='rgb(50, 25, 35)');
    record('right-panel content stays native',css('#right-main').backgroundColor==='rgb(36, 36, 36)');
    record('right-panel fade stays native',css('#right-fade').getPropertyValue('--tw-gradient-from').trim()==='#242424');
    record('UI font size follows the override',css('#text').fontSize==='20px');
    record('code font is not overridden',css('#code').fontSize==='13px');
    const native=structuredClone(map);native.tasks['local:one']='native';api.update(native);
    record('explicit native removes only theme colors',css('#main').backgroundColor==='rgb(36, 36, 36)'&&css('#text').fontSize==='20px');
    const disabled=structuredClone(map);disabled.enabledColors.surface=false;api.update(disabled);
    record('a channel can be disabled independently',css('#main').backgroundColor==='rgb(36, 36, 36)'&&css('#sidebar').backgroundColor==='rgb(27, 16, 21)');
    api.update(map);
    fixture.hold=true;
    const requested=new Promise(resolve=>window.addEventListener('fixture-request',resolve,{once:true}));
    const oldRefresh=api.refresh();await requested;
    fixture.navigate('two');api.update(map);
    record('navigation never reuses the previous thread project',css('#main').backgroundColor==='rgb(16, 33, 62)');
    fixture.hold=false;fixture.release();await oldRefresh;
    await next(report=>report.context?.taskKey==='local:two'&&report.context.source==='app-server');
    record('late old metadata cannot overwrite the new project',css('#main').backgroundColor==='rgb(16, 33, 62)');
    document.getElementById('sidebar').remove();await api.refresh();
    record('closing the sidebar does not lose thread identity',reports.at(-1).context.taskKey==='local:two');
    record('bootstrap catalog remains available without the sidebar',reports.at(-1).catalog.tasks.length===2);
    const follow=structuredClone(map);follow.uiFontSizeOverride=null;api.update(follow);
    record('following Codex restores native UI font tokens',css('#text').fontSize==='14px');
    const main=document.getElementById('main');main.className='changed-native-surface';api.update(follow);
    record('a changed native main-surface selector is reported instead of healthy native fallback',reports.at(-1).errors.some(error=>error.source==='main-surface'));
    main.className='_MainContentSurface_fixture';api.update(follow);
    record('restoring the native interface clears only its own compatibility error',!reports.at(-1).errors.some(error=>error.source==='main-surface'));
    api.cleanup();
    record('cleanup removes only owned style and variables',!document.getElementById('cdtk-themes-style')&&!document.documentElement.className.includes('cdtk-')&&css('#main').backgroundColor==='rgb(36, 36, 36)');
    window.eval(externalPayload);
    const legacy=window.__CODEX_DESKTOP_TOOLKIT_THEMES__; await legacy.refresh();
    record('legacy Themes hands off only the font override',css('#text').fontSize==='14px'&&css('#main').backgroundColor==='rgb(16, 33, 62)'&&!document.documentElement.classList.contains('cdtk-ui-font-override'));
    await (0,eval)(fontPayload);
    const fontHost=window.__CODEXTOPKITS_FEATURE_HOST__;
    record('standalone font Kit uses shared settings without changing code fonts',css('#text').fontSize==='20px'&&css('#code').fontSize==='13px');
    fontHost.setRuntimeState({themeSettings:{uiFontSizeOverride:18}});
    record('a shared settings change updates the font immediately',css('#text').fontSize==='18px');
    fontHost.setRuntimeState({themeSettings:{uiFontSizeOverride:null}});
    record('following Codex restores only its native font',css('#text').fontSize==='14px'&&css('#main').backgroundColor==='rgb(16, 33, 62)');
    fontHost.setRuntimeState({themeSettings:{uiFontSizeOverride:20}});
    legacy.cleanup();
    record('stopping legacy Themes leaves the standalone font active',css('#text').fontSize==='20px'&&css('#main').backgroundColor==='rgb(36, 36, 36)');
    await fontHost.close();delete window.__CODEXTOPKITS_FEATURE_HOST__;
    record('stopping the font Kit restores native sizing',css('#text').fontSize==='14px'&&!document.querySelector('style[data-cdtk-owned="ui-font-size"]'));
    window.eval(colorExternalPayload);
    const legacyColors=window.__CODEX_DESKTOP_TOOLKIT_THEMES__; await legacyColors.refresh();
    record('legacy Themes hands off only project colors',css('#main').backgroundColor==='rgb(36, 36, 36)'&&css('#text').fontSize==='20px');
    const readsBeforeKit=fixture.reads;
    await (0,eval)(colorPayload);const colorHost=window.__CODEXTOPKITS_FEATURE_HOST__;
    record('color Kit reuses legacy context without a duplicate native query',css('#main').backgroundColor==='rgb(16, 33, 62)'&&fixture.reads===readsBeforeKit&&css('#right-main').backgroundColor==='rgb(36, 36, 36)');
    document.documentElement.style.colorScheme='light';
    const blueReference=document.createElement('span');blueReference.style.background='color-mix(in srgb,#4f8fe8 30%,white)';document.body.appendChild(blueReference);
    record('color Kit legacy handoff uses the original accent at 30%',css('#main').backgroundColor===getComputedStyle(blueReference).backgroundColor&&css('#main').backgroundColor===css('#consumer').backgroundColor);
    document.documentElement.style.colorScheme='dark';
    const nativeColor=structuredClone(map);nativeColor.tasks['local:two']='native';legacyColors.update(nativeColor);colorHost.setRuntimeState({themeSettings:{uiFontSizeOverride:20,map:nativeColor}});
    record('color Kit applies a task native override without affecting the font',css('#main').backgroundColor==='rgb(36, 36, 36)'&&css('#text').fontSize==='20px');
    const disabledSurface=structuredClone(map);disabledSurface.enabledColors.surface=false;colorHost.setRuntimeState({themeSettings:{uiFontSizeOverride:20,map:disabledSurface}});
    record('a color channel can be disabled independently',css('#main').backgroundColor==='rgb(36, 36, 36)'&&document.documentElement.classList.contains('cdtk-theme-sidebar'));
    colorHost.setRuntimeState({themeSettings:{uiFontSizeOverride:20,map}});
    await colorHost.close();delete window.__CODEXTOPKITS_FEATURE_HOST__;
    record('stopping the color Kit leaves the legacy font active',css('#main').backgroundColor==='rgb(36, 36, 36)'&&css('#text').fontSize==='20px');
    legacyColors.cleanup();
    await (0,eval)(colorPayload);const standaloneColors=window.__CODEXTOPKITS_FEATURE_HOST__;
    record('standalone color Kit reads the native project without the legacy module',css('#main').backgroundColor==='rgb(16, 33, 62)'&&css('#text').fontSize==='14px');
    document.documentElement.style.colorScheme='light';
    record('standalone color Kit uses the original accent at 30%',css('#main').backgroundColor===getComputedStyle(blueReference).backgroundColor&&css('#main').backgroundColor===css('#consumer').backgroundColor);
    blueReference.remove();
    document.documentElement.style.colorScheme='dark';
    fixture.navigate('one');await new Promise(resolve=>setTimeout(resolve,0));
    record('standalone color Kit follows chat navigation and preserves the right panel',css('#main').backgroundColor==='rgb(50, 25, 35)'&&css('#right-main').backgroundColor==='rgb(36, 36, 36)');
    await standaloneColors.close();delete window.__CODEXTOPKITS_FEATURE_HOST__;
    record('stopping standalone colors restores the native background',css('#main').backgroundColor==='rgb(36, 36, 36)');
    window.eval(bothExternalPayload);const legacyBoth=window.__CODEX_DESKTOP_TOOLKIT_THEMES__;await legacyBoth.refresh();
    await (0,eval)(bothPayload);const bothHost=window.__CODEXTOPKITS_FEATURE_HOST__;
    record('color and font Kits can share the legacy settings context',css('#main').backgroundColor==='rgb(50, 25, 35)'&&css('#text').fontSize==='20px');
    await bothHost.stop('ui-font-size');record('stopping only font retains project colors',css('#main').backgroundColor==='rgb(50, 25, 35)'&&css('#text').fontSize==='14px');
    await bothHost.start('ui-font-size');await bothHost.stop('project-thread-colors');
    record('stopping only colors retains the independent font',css('#main').backgroundColor==='rgb(36, 36, 36)'&&css('#text').fontSize==='20px');
    legacyBoth.cleanup();await bothHost.close();delete window.__CODEXTOPKITS_FEATURE_HOST__;
    window.eval(shadowExternalPayload);const legacyShadow=window.__CODEX_DESKTOP_TOOLKIT_THEMES__;await legacyShadow.refresh();
    record('legacy Themes hands off the profile shadow',css('#profile-fixture').boxShadow==='none');
    await (0,eval)(shadowPayload);const shadowHost=window.__CODEXTOPKITS_FEATURE_HOST__;
    record('standalone profile shadow keeps the exact existing visual style',css('#profile-fixture').boxShadow===originalShadow);
    legacyShadow.cleanup();record('stopping legacy Themes leaves the standalone shadow',css('#profile-fixture').boxShadow===originalShadow);
    await shadowHost.close();delete window.__CODEXTOPKITS_FEATURE_HOST__;
    record('stopping profile shadow restores the native menu',css('#profile-fixture').boxShadow==='none');profile.remove();
    document.querySelectorAll('main').forEach(element=>element.remove());document.body.style.background='transparent';
    window.eval(payload);
    record('non-main overlays retain transparency and native font settings',css('body').backgroundColor==='rgba(0, 0, 0, 0)'&&!document.getElementById('cdtk-themes-style')&&!document.documentElement.classList.contains('cdtk-ui-font-override'));
    window.__CODEX_DESKTOP_TOOLKIT_THEMES__.cleanup();
    output({ok:true,checks,observedAt:new Date().toISOString(),userAgent:navigator.userAgent});
  } catch(error) { output({ok:false,checks,error:{name:error.name,message:error.message,stack:error.stack},reports:reports.slice(-3)}); }
}

async function managerChecks() {
  const checks=[];
  const record=(name,passed)=>{checks.push({name,passed});if(!passed)throw new Error(name);};
  const wait=predicate=>predicate()?Promise.resolve():new Promise(resolve=>{const observer=new MutationObserver(()=>{if(predicate()){observer.disconnect();resolve();}});observer.observe(document.body,{childList:true,subtree:true,attributes:true});});
  const output=value=>{
    const pre=document.createElement('pre');pre.id='result';pre.setAttribute('data-result',encodeURIComponent(JSON.stringify(value)));pre.textContent=JSON.stringify(value);document.body.appendChild(pre);
    void fetch('/fixture-result',{method:'POST',body:JSON.stringify(value)});
    events?.close();
  };
  try {
    await i18n.ready;
    document.documentElement.style.colorScheme='dark';
    await wait(()=>document.querySelector('button[data-kind="project"]'));
    await window.fixtureLocale('zh-Hans','system');
    record('automatic language uses system language when host language is unavailable',document.documentElement.lang==='zh-Hans'&&document.querySelector('h1').textContent==='Codex 主题管理器');
    await window.fixtureLocale('en');
    document.querySelector('button[data-kind="project"][data-key="Alpha"]').click();
    const select=document.getElementById('assignment');select.focus();
    record('palette opens with the actual project assignment',select.value==='red');
    const projectButton=document.querySelector('button[data-kind="project"][data-key="Alpha"]'),font=document.getElementById('ui-font-size');
    const sample=projectButton.querySelector('.swatch'),darkSample=getComputedStyle(sample).backgroundColor;
    document.documentElement.style.colorScheme='light';
    const reference=document.createElement('span');reference.style.background='#ef5c70';document.body.appendChild(reference);
    record('light manager swatches retain the original accent without rebuilding controls',getComputedStyle(sample).backgroundColor===getComputedStyle(reference).backgroundColor&&getComputedStyle(sample).color===getComputedStyle(reference).backgroundColor&&getComputedStyle(document.querySelector('#details .swatch')).backgroundColor===getComputedStyle(reference).backgroundColor&&document.getElementById('assignment')===select);
    record('light manager foreground and panel are readable',getComputedStyle(document.documentElement).color==='rgb(26, 28, 31)'&&getComputedStyle(document.querySelector('.panel')).backgroundColor!=='rgba(23, 30, 42, 0.91)');
    document.documentElement.style.colorScheme='dark';reference.remove();
    record('dark manager swatch returns to its original color',getComputedStyle(sample).backgroundColor===darkSample&&darkSample==='rgb(239, 92, 112)');
    await window.fixtureLocale('zh-Hans');
    record('language switch retains the focused palette and list controls',document.getElementById('assignment')===select&&document.activeElement===select&&select.value==='red'&&document.querySelector('button[data-kind="project"][data-key="Alpha"]')===projectButton&&document.getElementById('ui-font-size')===font);
    record('language switch translates palette, labels and project color',select.querySelector('option[value="red"]').textContent==='红色'&&select.querySelector('option[value="native"]').textContent==='原生（不使用主题色）'&&projectButton.querySelector('.pill').textContent==='红色'&&document.querySelector('#details .hint').textContent.includes('继承'));
    await window.fixtureLocale('en');
    record('switching back keeps the selection and updates text',document.getElementById('assignment')===select&&select.value==='red'&&select.querySelector('option[value="red"]').textContent==='Red');
    const update=wait(()=>document.querySelector('button[data-kind="task"] .item-name').textContent==='Updated fixture title');
    await fetch('/fixture-update',{method:'POST'});await update;
    record('pushed changes do not rebuild an open palette',document.getElementById('assignment')===select&&select.isConnected&&select.value==='red');
    await window.fixtureLocale('zh-Hans');
    record('language switch preserves the open palette’s displayed state after a push',select.value==='red'&&document.querySelector('#details .effective span:not(.swatch)').textContent==='红色');
    await window.fixtureLocale('en');
    select.blur();await wait(()=>document.getElementById('assignment').value==='blue');
    const changed=document.getElementById('assignment');changed.value='green';changed.dispatchEvent(new Event('change',{bubbles:true}));
    await wait(()=>document.querySelector('button[data-kind="project"][data-key="Alpha"] .pill').textContent==='Green');
    record('assignment save updates the list representative color',getComputedStyle(document.querySelector('button[data-kind="project"][data-key="Alpha"] .swatch')).backgroundColor==='rgb(84, 201, 139)');
    document.querySelector('button[data-kind="task"]').click();
    record('task defaults inherit and match the project swatch',document.getElementById('assignment').value==='inherit'&&getComputedStyle(document.querySelector('#details .swatch')).backgroundColor==='rgb(84, 201, 139)');
    const taskSelect=document.getElementById('assignment');taskSelect.focus();await window.fixtureLocale('zh-Hans');
    record('thread language switch retains inherited selection and user title',document.getElementById('assignment')===taskSelect&&document.activeElement===taskSelect&&taskSelect.value==='inherit'&&taskSelect.options[0].textContent==='继承（跟随工程）'&&document.querySelector('#details h2').textContent==='Updated fixture title');
    taskSelect.blur();await window.fixtureLocale('en');
    const surface=document.querySelector('[data-channel="surface"]');surface.click();await wait(()=>!surface.disabled);
    const state=await(await fetch('api/state')).json();
    record('global color channels save through the shared management API',state.map.enabledColors.surface===false);
    record('list and control text sizes remain unchanged',getComputedStyle(document.querySelector('.item-name')).fontSize==='14px'&&getComputedStyle(document.querySelector('.font-size-control')).fontSize==='12px');
    record('UI font choices include native and 11 through 24',document.getElementById('ui-font-size').options.length===15);
    await fetch('/fixture-error',{method:'POST'});await wait(()=>document.querySelector('#health-alert li'));
    const diagnostic=document.querySelector('#health-alert li');await window.fixtureLocale('zh-Hans');
    record('language switch translates the status while preserving native diagnostic text and node',document.querySelector('#health-alert li')===diagnostic&&diagnostic.textContent.includes('raw native error')&&document.querySelector('#health-alert h2').textContent.includes('问题')&&document.getElementById('status').textContent.includes('告警'));
    i18n.close();await fetch('/fixture-locale?value=en',{method:'POST'});
    record('closing localization stops further language updates',document.documentElement.lang==='zh-Hans');
    output({ok:true,checks,observedAt:new Date().toISOString()});
  }catch(error){output({ok:false,checks,error:{name:error.name,message:error.message,stack:error.stack}});}
}

const html=`<!doctype html><meta charset="utf-8"><style>:root{color-scheme:dark;--text-base:14px;--vscode-editor-font-size:13px}body{display:flex;background:#111111}aside{width:160px;background:#161616}main{width:480px;background:#242424}header{display:block}#text{font-size:var(--text-base)}#code{font-size:var(--vscode-editor-font-size)}#consumer{background:var(--cdtk-surface)}.from-surface{--tw-gradient-from:#242424}</style><aside id="sidebar" class="app-shell-left-panel"><div data-app-action-sidebar-thread-id="one" data-app-action-sidebar-thread-title="First" data-app-action-sidebar-thread-active="true" aria-current="page">First</div><div data-app-action-sidebar-thread-id="two" data-app-action-sidebar-thread-title="Second">Second</div></aside><section class="app-shell-main-content-viewport"><header><button id="project" aria-label="Project: Alpha">Project</button></header><main id="main" class="_MainContentSurface_fixture"><div class="_Workspace_fixture"><div data-codex-composer-root><span data-above-composer-conversation-id="one"></span><textarea>composer</textarea></div><p id="text">fixture text</p><code id="code">fixture code</code><div id="consumer"></div></div></main></section><aside data-app-shell-tab-panel-controller="right"><main id="right-main" class="_MainContentSurface_fixture"><div class="thread-scroll-container"><div id="right-fade" class="pointer-events-none absolute inset-x-0 from-surface">fade</div></div></main></aside><pre id="result">running</pre><script type="module" src="/assets/main.fixture.js"></script><script type="module">(${browserChecks.toString()})(${JSON.stringify(map)},${JSON.stringify(themePayload(map))},${JSON.stringify(themePayload(map,{externalKits:['ui-font-size']}))},${JSON.stringify(kitPayload([fontKit],{runtimeState:{themeSettings:{uiFontSizeOverride:20}}}))},${JSON.stringify(themePayload(map,{externalKits:['project-thread-colors']}))},${JSON.stringify(kitPayload([colorKit],{runtimeState:{themeSettings:{uiFontSizeOverride:20,map}}}))},${JSON.stringify(themePayload(map,{externalKits:['project-thread-colors','ui-font-size']}))},${JSON.stringify(kitPayload([colorKit,fontKit],{runtimeState:{themeSettings:{uiFontSizeOverride:20,map}}}))},${JSON.stringify(themePayload(map,{externalKits:['profile-panel-shadow']}))},${JSON.stringify(kitPayload([profileKit]))});</script>`;
await fs.writeFile(path.join(root, 'fixture.html'), html, 'utf8');
let managerMap=structuredClone(map), managerRevision=1, taskTitle='First',managerErrors=[];
const requests=[];
const streams=new Set();
const localeStreams=new Set();
let locale='en';
const managerState=()=>({map:managerMap,revision:managerRevision,errors:managerErrors,windows:[],catalog:{projects:['Alpha','Beta'].map(name=>({name,...resolveTheme(managerMap,{projectName:name})})),tasks:[{taskKey:'local:one',title:taskTitle,projectName:'Alpha',...resolveTheme(managerMap,{taskKey:'local:one',projectName:'Alpha'})}]}});
const push=()=>{managerRevision++;for(const stream of streams)stream.write('data: '+JSON.stringify(managerState())+'\n\n','utf8');};
const server=http.createServer(async(request,response)=>{
  requests.push({at:new Date().toISOString(),method:request.method,url:request.url});
  const json=value=>{response.writeHead(200,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify(value),'utf8');};
  if(request.url==='/fixture-result'){
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    await fs.writeFile(path.join(root,'manager-driver-result.json'),Buffer.concat(chunks));json({ok:true});return;
  }
  if(request.url==='/management-localization.js'){
    response.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});
    response.end(`window.createCodexTopKitsManagementI18n=options=>(${createManagementI18n.toString()})(${createLocalization.toString()},options);window.fixtureLocale=async (value,source='host')=>{await fetch('/fixture-locale?value='+encodeURIComponent(value)+'&source='+source,{method:'POST'});if(document.documentElement.lang===value)return;await new Promise(resolve=>{const observer=new MutationObserver(()=>{if(document.documentElement.lang===value){observer.disconnect();resolve();}});observer.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});});};`,'utf8');return;
  }
  if(request.url==='/api/localization'){json({preference:{mode:'auto'},hostLanguage:locale==='en'?'en-US':'zh-CN',systemLanguage:locale==='en'?'zh-CN':'en-US'});return;}
  if(request.url==='/api/events'){response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'});localeStreams.add(response);response.once('close',()=>localeStreams.delete(response));return;}
  if(request.url.startsWith('/fixture-locale?')){const params=new URL(request.url,'http://localhost').searchParams;locale=params.get('value');const language=locale==='en'?'en-US':'zh-CN';for(const stream of localeStreams)stream.write('data: '+JSON.stringify({languagePreference:{mode:'auto'},hostLanguage:params.get('source')==='system'?null:language,systemLanguage:params.get('source')==='system'?language:locale==='en'?'zh-CN':'en-US'})+'\n\n','utf8');json({ok:true});return;}
  if(request.url==='/manager/'){response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(manager.replace('</body>',`<script type="module">(${managerChecks.toString()})();</script></body>`),'utf8');return;}
  if(request.url==='/manager/api/state'){json(managerState());return;}
  if(request.url==='/manager/api/events'){response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'});streams.add(response);response.write('data: '+JSON.stringify(managerState())+'\n\n','utf8');response.once('close',()=>streams.delete(response));return;}
  if(request.url==='/fixture-update'){taskTitle='Updated fixture title';managerMap.projects.Alpha='blue';push();json({ok:true});return;}
  if(request.url==='/fixture-error'){managerErrors=[{targetId:'fixture',message:'raw native error'}];push();json({ok:true});return;}
  if(request.method==='POST'&&request.url.startsWith('/manager/api/')){
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
    if(request.url.endsWith('/assignment')){const section=body.kind==='project'?'projects':'tasks';managerMap=validateMap({...managerMap,[section]:{...managerMap[section],[body.key]:body.value}});}
    if(request.url.endsWith('/appearance'))managerMap=validateMap({...managerMap,...body});
    push();json(managerState());return;
  }
  if(request.url==='/assets/main.fixture.js'){response.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});response.end(nativeModule,'utf8');}
  else if(request.url==='/'){response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(html,'utf8');}
  else{response.writeHead(404);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  const results=[];
  for(const [name,route] of [['main','/'],['manager','/manager/']]){
    let stdout,stderr;
    try { ({stdout,stderr}=await promisify(execFile)(executable,['--headless=new','--disable-background-networking','--disable-sync','--disable-extensions','--no-first-run','--no-default-browser-check','--user-data-dir='+path.join(root,name+'-profile'),'--dump-dom','--virtual-time-budget=10000',`http://127.0.0.1:${server.address().port}${route}`],{windowsHide:true,encoding:'utf8',maxBuffer:2*1024*1024,timeout:60000})); }
    catch(error){await fs.writeFile(path.join(root,name+'-stderr.log'),error.stderr||'','utf8');await fs.writeFile(path.join(root,'fixture-requests.json'),JSON.stringify(requests,null,2),'utf8');throw error;}
    await fs.writeFile(path.join(root,name+'-dom.html'),stdout,'utf8');await fs.writeFile(path.join(root,name+'-stderr.log'),stderr,'utf8');
    const match=stdout.match(/<pre\b[^>]*\bid="result"[^>]*\bdata-result="([^"]+)"/);
    assert.ok(match,'Browser fixture did not finish; inspect '+path.join(root,name+'-dom.html'));
    const result=JSON.parse(decodeURIComponent(match[1]));await fs.writeFile(path.join(root,name+'-result.json'),JSON.stringify(result,null,2)+'\n','utf8');
    assert.equal(result.ok,true,JSON.stringify(result));results.push({name,checks:result.checks.length,report:path.join(root,name+'-result.json')});
  }
  console.log(JSON.stringify({ok:true,results,observedAt:new Date().toISOString()}));
} finally {await fs.writeFile(path.join(root,'fixture-requests.json'),JSON.stringify(requests,null,2)+'\n','utf8');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
