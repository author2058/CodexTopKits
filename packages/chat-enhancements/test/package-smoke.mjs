import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const installation=path.resolve(process.argv[2]||''), powershellPath=process.argv[3];
if(!path.isAbsolute(process.argv[2]||'')||!path.isAbsolute(powershellPath||''))throw new Error('Pass the independent installation directory and standalone PowerShell executable.');
const require=createRequire(path.join(installation,'package.json'));
const core=await import(pathToFileURL(require.resolve('codex-toolkit-core')));
const bandwidth=(await import(pathToFileURL(require.resolve('codex-bandwidth')))).default;
const themes=(await import(pathToFileURL(require.resolve('codex-toolkit-themes')))).default;
const chat=(await import(pathToFileURL(require.resolve('codex-toolkit-chat')))).default;
const voice=process.argv.includes('--voice')?(await import(pathToFileURL(require.resolve('codex-toolkit-voice')))).default:null;
const windows=process.argv.includes('--windows')?(await import(pathToFileURL(require.resolve('codex-toolkit-windows')))).default:null;
const session=process.argv.includes('--session')?(await import(pathToFileURL(require.resolve('codex-toolkit-session')))).default:null;
assert.equal(require.resolve('codex-toolkit-core'),createRequire(require.resolve('codex-bandwidth')).resolve('codex-toolkit-core'));
assert.equal(require.resolve('codex-toolkit-core'),createRequire(require.resolve('codex-toolkit-themes')).resolve('codex-toolkit-core'));
assert.equal(require.resolve('codex-toolkit-core'),createRequire(require.resolve('codex-toolkit-chat')).resolve('codex-toolkit-core'));
if(voice)assert.equal(require.resolve('codex-toolkit-core'),createRequire(require.resolve('codex-toolkit-voice')).resolve('codex-toolkit-core'));
if(windows)assert.equal(require.resolve('codex-toolkit-core'),createRequire(require.resolve('codex-toolkit-windows')).resolve('codex-toolkit-core'));
if(session)assert.equal(require.resolve('codex-toolkit-core'),createRequire(require.resolve('codex-toolkit-session')).resolve('codex-toolkit-core'));
const {WebSocketServer}=createRequire(require.resolve('codex-bandwidth'))('ws');
const stateDirectory=path.join(installation,'smoke-state');
await fs.mkdir(stateDirectory,{recursive:true});
let connections=0, starts=0, ends=0, next=0, runtime, reader, targetId='main';
const browser=http.createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify({webSocketDebuggerUrl:`ws://127.0.0.1:${browser.address().port}/devtools/browser/fixture`}), 'utf8');});
const sockets=new WebSocketServer({server:browser});
sockets.on('connection',socket=>{
  connections++;
  socket.on('message',bytes=>{
    const command=JSON.parse(bytes);let result={};
    if(command.method==='Target.getTargets')result={targetInfos:[{targetId,type:'page',url:'app://codex/fixture'}]};
    if(command.method==='SystemInfo.getProcessInfo')result={processInfo:[{type:'browser',id:123}]};
    if(command.method==='Target.attachToTarget')result={sessionId:'fixture-'+ ++next};
    if(command.method==='Page.addScriptToEvaluateOnNewDocument')result={identifier:'script-'+next};
    if(command.method==='Runtime.evaluate')result={result:{value:command.params.expression.includes('].ensure(')?{ok:true,stage:'verified'}:{applicable:true}}};
    if(command.method==='Tracing.start')starts++;
    if(command.method==='Tracing.end')ends++;
    socket.send(JSON.stringify({id:command.id,result}));
    if(command.method==='Runtime.evaluate'&&!command.params.expression.includes('?.cleanup()'))socket.send(JSON.stringify({method:'Runtime.bindingCalled',sessionId:command.sessionId,params:{name:'__CDTK_THEMES_REPORT__',payload:JSON.stringify({applicable:true,context:{taskKey:'local:fixture',projectName:'FixtureProject'},errors:[],catalog:{projects:[{name:'FixtureProject',rootPaths:['S:/fixtures/project']}],tasks:[{taskKey:'local:fixture',title:'Fixture chat',projectName:'FixtureProject'}]}})}}));
    if(command.method==='Runtime.evaluate'&&command.params.expression.includes('__CDTK_CHAT_BRIDGE__'))socket.send(JSON.stringify({method:'Runtime.bindingCalled',sessionId:command.sessionId,params:{name:'__CDTK_CHAT_BRIDGE__',payload:JSON.stringify({kind:'state',applicable:true,threadId:'fixture',errors:[],capabilities:{initialized:true,rpc:true,formatter:true,usage:false,speedPanels:['main:fixture']}})}}));
    if(command.method==='Runtime.evaluate'&&command.params.expression.includes('__CDTK_VOICE_BRIDGE__'))socket.send(JSON.stringify({method:'Runtime.bindingCalled',sessionId:command.sessionId,params:{name:'__CDTK_VOICE_BRIDGE__',payload:JSON.stringify({applicable:true,status:{ready:true,active:false,state:null},error:null})}}));
    if(command.method==='Runtime.evaluate'&&command.params.expression.includes('__CDTK_WINDOWS_BRIDGE__'))socket.send(JSON.stringify({method:'Runtime.bindingCalled',sessionId:command.sessionId,params:{name:'__CDTK_WINDOWS_BRIDGE__',payload:JSON.stringify({kind:'state',applicable:true,taskKey:'local:fixture',title:'Fixture',focused:false,status:'idle',color:'#445566',errors:[]})}}));
    if(command.method==='Runtime.evaluate'&&command.params.expression.includes('__CDTK_SESSION_BRIDGE__'))socket.send(JSON.stringify({method:'Runtime.bindingCalled',sessionId:command.sessionId,params:{name:'__CDTK_SESSION_BRIDGE__',payload:JSON.stringify({kind:'state',applicable:true,runtime:[],errors:[]})}}));
    if(command.method==='Tracing.end')socket.send(JSON.stringify({method:'Tracing.tracingComplete',params:{}}));
  });
});
await new Promise(resolve=>browser.listen(0,'127.0.0.1',resolve));
const port=browser.address().port, abort=new AbortController();
const timeout=setTimeout(()=>abort.abort(new Error('Independent package smoke did not finish within 60 seconds.')),60000);
try{
  const nativeWindow={async open(){},async close(){},async powerStatus(){return{ready:true,sequence:0,type:null,observedAt:1};},async subscribePower(listener){await listener(await this.powerStatus());}};
  runtime=await (await import(pathToFileURL(require.resolve('codex-toolkit-core/runtime')))).startRuntime({stateDirectory,plugins:[bandwidth({powershellPath,cdpPort:port}),themes({cdpPort:port}),chat({cdpPort:port}, {hardResetFetch:async()=>Response.json({data:{scheduled_reset:null}})}),...(voice?[voice({cdpPort:port})]:[]),...(windows?[windows({cdpPort:port,powershellPath},{createWorker:()=>nativeWindow,sleep:async()=>{throw new Error('Must not sleep in package smoke');}})]:[]),...(session?[session({cdpPort:port})]:[])]});
  const base=runtime.status().managerUrl;
  const events=await fetch(base+'plugins/themes/api/events',{signal:abort.signal});
  reader=events.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let text='', pending=[];
  const nextState=async predicate=>{
    for(;;){
      while(pending.length){const value=pending.shift();if(predicate(value))return value;}
      const part=await reader.read();if(part.done)throw new Error('Theme event stream closed early.');
      text+=decoder.decode(part.value,{stream:true});
      const chunks=text.split('\n\n');text=chunks.pop();pending.push(...chunks.filter(chunk=>chunk.startsWith('data: ')).map(chunk=>JSON.parse(chunk.slice(6))));
    }
  };
  const current=await nextState(value=>value.catalog.tasks.some(task=>task.taskKey==='local:fixture'));
  const color=current.map.projects.FixtureProject==='blue'?'red':'blue';
  const request=async(route,body)=>{
    const response=await fetch(base+route,{method:'POST',signal:abort.signal,headers:{'content-type':'application/json','x-codex-toolkit-action':'manage'},body:JSON.stringify(body)});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
  };
  const assigned=await request('plugins/themes/api/assignment',{kind:'project',key:'FixtureProject',value:color});
  assert.equal(assigned.catalog.tasks[0].themeId,color);
  await nextState(value=>value.catalog.tasks[0]?.themeId===color);
  assert.deepEqual(await request('plugins/bandwidth/api/traffic-capture',{enabled:true}),{enabled:true});
  const chatState=await(await fetch(base+'plugins/chat/api/state')).json();
  assert.equal(chatState.errors.length,0);assert.equal(chatState.windows.length,1);
  assert.equal(chatState.hostState.managerUrl,base);
  assert.equal((await fetch(base+'plugins/chat/')).status,200);
  if(voice){const voiceState=await(await fetch(base+'plugins/voice/api/state')).json();assert.equal(voiceState.errors.length,0);assert.equal(voiceState.windows[0].status.ready,true);assert.equal((await fetch(base+'plugins/voice/')).status,200);}
  if(windows){const windowsState=await(await fetch(base+'plugins/windows/api/state')).json();assert.equal(windowsState.errors.length,0);assert.equal(windowsState.windows.length,1);assert.equal(windowsState.autoSleep.enabled,false);assert.equal((await fetch(base+'plugins/windows/')).status,200);}
  if(session){const state=await(await fetch(base+'plugins/session/api/state')).json();assert.equal(state.errors.length,0);assert.equal(state.windows.length,1);assert.equal((await fetch(base+'plugins/session/')).status,200);await request('plugins/session/api/runtime/register',{threadId:'child',settings:{model:'luna',effort:'xhigh',serviceTier:'priority'},ensure:false});assert.equal((await request('plugins/session/api/runtime/prepare-send',{threadId:'child'})).route,'multi_agent_v1.send_input');}
  assert.equal(connections,1);assert.equal(starts,1);
  assert.equal(runtime.status().cdp.connected,true);
  assert.equal((await fetch(base+'plugins/themes/')).status,200);
  const traffic=await(await fetch(base+'plugins/bandwidth/api/traffic')).json();
  assert.equal(traffic.coverage.find(value=>value.id==='chromium').status,'active');
  assert.deepEqual(await request('plugins/bandwidth/api/traffic-capture',{enabled:false}),{enabled:false});
  assert.equal(ends,1);assert.equal(runtime.status().cdp.connected,true);
  targetId='replacement';for(const socket of sockets.clients)socket.close();
  await nextState(value=>value.windows.some(row=>row.targetId==='replacement'));
  for(const id of ['themes','chat',...(voice?['voice']:[]),...(windows?['windows']:[]),...(session?['session']:[])]){
    let state;
    for(let attempt=0;attempt<100;attempt++){state=await(await fetch(base+'plugins/'+id+'/api/state',{signal:abort.signal})).json();if(state.windows.length===1&&state.windows[0].targetId==='replacement'&&state.errors.length===0)break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(state.windows.length,1,id);assert.equal(state.windows[0].targetId,'replacement',id);assert.equal(state.errors.length,0,id+': '+JSON.stringify(state.errors));
  }
  assert.equal(connections,2);assert.equal(starts,1);assert.equal(ends,1);
  await reader.cancel();reader=null;await runtime.close();
  const result={ok:true,sharedCore:true,connections,starts,ends,reconnected:true,orphanedTargetsRemoved:true,themeEvents:true,chatManagement:true,voiceManagement:Boolean(voice),windowsManagement:Boolean(windows),sessionManagement:Boolean(session),management:true,localOnly:true,realModelCalls:0,observedAt:new Date().toISOString()};
  await fs.writeFile(path.join(installation,'package-smoke.json'),JSON.stringify(result,null,2)+'\n','utf8');
  console.log(JSON.stringify(result));
}finally{
  clearTimeout(timeout);await reader?.cancel();await runtime?.close();for(const socket of sockets.clients)socket.terminate();await new Promise(resolve=>sockets.close(resolve));browser.closeAllConnections();await new Promise(resolve=>browser.close(resolve));
}
