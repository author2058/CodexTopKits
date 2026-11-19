import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import pluginFactory from '../src/index.mjs';
import { sessionPayload } from '../src/payload.mjs';
import { kitModule } from 'codex-toolkit-core/kits';
import agentComposer from '../kits/agent-composer/index.mjs';
import agentModelProtection from '../kits/agent-model-protection/index.mjs';
import createModelProtectionService from '../src/model-protection-service.mjs';
import { openRuntimeRegistry } from '../src/registry.mjs';

test('payload and manager inline script parse independently',async()=>{
  new vm.Script(sessionPayload({epoch:'fixture',registry:{threads:{}},restoreAgentComposer:false}));
  assert.equal(agentComposer.manifest.id,'agent-composer');
  new vm.Script(kitModule(agentComposer).replace(/^export default /,''));
  assert.equal(agentModelProtection.manifest.id,'agent-model-protection');new vm.Script(kitModule(agentModelProtection).replace(/^export default /,''));
  const page=await fs.readFile(new URL('../assets/session-manager.html',import.meta.url),'utf8');for(const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
test('model protection service requires explicit ownership handoff',async()=>{
  await assert.rejects(createModelProtectionService({}, {getPlugin:()=>({modelProtectionHandedOff:false})}),/hand off/);
  const service=await createModelProtectionService({}, {getPlugin:()=>({modelProtectionHandedOff:true})});assert.deepEqual(service.snapshot(),{});service.close();
  assert.throws(()=>pluginFactory({externalKits:['unknown']}),/Invalid external/);
});
test('management distinguishes ordinary peers and protected children, clears dead targets and reconnects',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cdtk-session-plugin-'));t.after(()=>fs.rm(folder,{recursive:true}));
  const health=[],logs=[],calls=[];let reconnect,acquires=0,releaseBlocked=false;
  const clients=[];const makeClient=()=>{const client={closed:false,handlers:new Set(),targets:()=>[{targetId:'main',type:'page',url:'app://codex/'}],async send(method,params,sessionId,timeoutMs){calls.push({method,params,sessionId,timeoutMs});if(method==='Target.attachToTarget')return{sessionId:'main-session'};if(method==='Page.addScriptToEvaluateOnNewDocument')return{identifier:'own-script'};if(method==='Runtime.evaluate'){if(releaseBlocked&&params.expression.includes('checkUnprotect'))return{exceptionDetails:{exception:{description:'Update or disable the old model Kit.'}}};return{result:{value:params.expression.includes('].ensure(')?{ok:true,threadId:'child',stage:'verified'}:{}}};}return{};},async close(){this.closed=true;}};clients.push(client);return client;};
  const context={stateDirectory:folder,cdp:{async acquire(){acquires++;return makeClient();},onReconnect(callback){reconnect=callback;return()=>reconnect=null;}},log:async value=>logs.push(value),setHealth:value=>health.push(value)};
  const plugin=await pluginFactory().start(context);t.after(()=>plugin.close());await new Promise(resolve=>setImmediate(resolve));
  const request=(pathname,body)=>plugin.management.request({method:body?'POST':'GET',url:new URL(pathname,'http://127.0.0.1'),body});
  const notify=async value=>{for(const handler of clients.at(-1).handlers)await handler({method:'Runtime.bindingCalled',sessionId:'main-session',params:{name:'__CDTK_SESSION_BRIDGE__',payload:JSON.stringify(value)}});};
  const before=calls.length;assert.equal((await request('/api/runtime/prepare-send',{threadId:'ordinary'})).body.route,'codex_app.send_message_to_thread');assert.equal(calls.length,before);
  await notify({kind:'state',applicable:true,errors:[],runtime:[]});
  const settings={model:'luna',effort:'xhigh',serviceTier:'priority'};const registration=await request('/api/runtime/register',{threadId:'child',parentThreadId:'parent',settings});assert.equal(registration.body.status.ok,true);
  assert.equal((await request('/api/runtime/prepare-send',{threadId:'child'})).body.route,'multi_agent_v1.send_input');assert.equal(calls.at(-1).timeoutMs,20000);
  await notify({kind:'runtime-status',status:{threadId:'child',ok:false,message:'native changed',stack:'original stack'}});assert.equal(health.at(-1).issueCount,1);
  releaseBlocked=true;await assert.rejects(request('/api/runtime/unprotect',{threadId:'child'}),/Update or disable/);
  assert.equal((await request('/api/state')).body.registry.threads.child.protected,true);releaseBlocked=false;
  const released=await request('/api/runtime/unprotect',{threadId:'child'});assert.equal(released.body.record.protected,false);assert.deepEqual(released.body.record.settings,settings);
  assert.equal(health.at(-1).issueCount,0);const afterRelease=calls.length;
  assert.equal((await request('/api/runtime/prepare-send',{threadId:'child'})).body.route,'codex_app.send_message_to_thread');assert.equal(calls.length,afterRelease);
  await assert.rejects(request('/api/runtime/ensure',{threadId:'child'}),/没有显式登记/);
  await notify({kind:'runtime-status',status:{threadId:'child',ok:false,message:'late obsolete failure'}});assert.equal(health.at(-1).issueCount,0);
  clients.at(-1).closed=true;for(const handler of clients.at(-1).handlers)await handler({method:'Target.targetDestroyed',params:{targetId:'main',toolkitDisconnect:true}});
  assert.equal((await request('/api/state')).body.windows.length,0);assert.equal(health.at(-1).issueCount,0);await reconnect();assert.equal(acquires,2);
  await plugin.close();assert.equal(reconnect,null);assert.equal(clients.at(-1).closed,true);assert.ok(logs.some(row=>row.event==='thread-runtime-registered'));
});
test('shutdown cancels a cold CDP wait without changing global configuration',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cdtk-session-plugin-'));t.after(()=>fs.rm(folder,{recursive:true}));let aborted=false;
  const plugin=await pluginFactory().start({stateDirectory:folder,cdp:{onReconnect:()=>()=>{},acquire:({signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}))},setHealth:()=>{},log:async()=>{}});
  await plugin.close();assert.equal(aborted,true);
});
test('Session defaults to the optional model Kit without enabling its built-in guard',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cdtk-session-handoff-'));t.after(()=>fs.rm(folder,{recursive:true}));
  const client={closed:false,handlers:new Set(),targets:()=>[],async close(){this.closed=true;}};
  const session=await pluginFactory().start({stateDirectory:folder,cdp:{onReconnect:()=>()=>{},acquire:async()=>client},setHealth:()=>{},log:async()=>{}});
  const service=await createModelProtectionService({}, {getPlugin:id=>id==='session'?session:null});assert.deepEqual(service.snapshot(),{});service.close();await session.close();
});

test('release waits for delayed installation and replaces the navigation snapshot',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cdtk-session-install-release-'));t.after(()=>fs.rm(folder,{recursive:true}));
  const store=await openRuntimeRegistry(path.join(folder,'runtime-settings.json'));
  await store.register({threadId:'child',settings:{model:'worker',effort:'medium',serviceTier:'default'}});await store.close();
  let releaseAdd,startedAdd,number=0;const blocked=new Promise(resolve=>releaseAdd=resolve),started=new Promise(resolve=>startedAdd=resolve),scripts=new Map(),evaluated=[];
  const client={closed:false,handlers:new Set(),targets:()=>[{targetId:'main',type:'page',url:'app://codex/'}],async send(method,params){
    if(method==='Target.attachToTarget')return{sessionId:'main-session'};
    if(method==='Page.addScriptToEvaluateOnNewDocument'){const identifier='script-'+ ++number;scripts.set(identifier,params.source);if(number===1){startedAdd();await blocked;}return{identifier};}
    if(method==='Page.removeScriptToEvaluateOnNewDocument')scripts.delete(params.identifier);
    if(method==='Runtime.evaluate'){evaluated.push(params.expression);return{result:{value:true}};}return{};
  },async close(){this.closed=true;}};
  const plugin=await pluginFactory().start({stateDirectory:folder,cdp:{acquire:async()=>client,onReconnect:()=>()=>{}},log:async()=>{},setHealth:()=>{}});
  t.after(()=>{releaseAdd();return plugin.close();});await started;
  let completed=false;const releasing=plugin.management.request({method:'POST',url:new URL('http://127.0.0.1/api/runtime/unprotect'),body:{threadId:'child'}}).then(value=>{completed=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,false);releaseAdd();await releasing;
  assert.equal(scripts.size,1);assert.ok([...scripts.values()][0].includes('"protected":false'));assert.ok(evaluated.at(-1).includes('"protected":false'));
  for(const handler of client.handlers)await handler({method:'Page.frameNavigated',sessionId:'main-session',params:{frame:{}}});
  assert.equal(scripts.size,1);assert.ok([...scripts.values()][0].includes('"protected":false'));assert.ok(evaluated.at(-1).includes('"protected":false'));
});
