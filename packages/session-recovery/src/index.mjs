import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CORE_API_VERSION } from 'codex-toolkit-core';
import { initializePage } from 'codex-toolkit-core/cdp';
import { openRuntimeRegistry } from './registry.mjs';
import { sessionPayload } from './payload.mjs';

const key='__CODEX_DESKTOP_TOOLKIT_SESSION__',binding='__CDTK_SESSION_BRIDGE__';
export default function sessionPlugin({cdpPort='auto',restoreAgentComposer=false,externalKits=['agent-model-protection']}={}) {
  if(CORE_API_VERSION!==1)throw new Error('Session Recovery requires Core API 1.');
  if(typeof restoreAgentComposer!=='boolean')throw new TypeError('restoreAgentComposer must be boolean.');
  if(!Array.isArray(externalKits)||externalKits.some(id=>id!=='agent-model-protection'))throw new TypeError('Invalid external Session Kit.');
  return{id:'session',coreApiVersion:1,cdpPort,async start(context){
    if(typeof context.cdp?.onReconnect!=='function')throw new Error('Session Recovery requires Core 0.3.5 or newer.');
    const registry=await openRuntimeRegistry(path.join(context.stateDirectory,'runtime-settings.json'));
    const page=await fs.readFile(new URL('../assets/session-manager.html',import.meta.url),'utf8');
    const lifetime=new AbortController(),epoch=randomUUID(),sessions=new Map(),attaching=new Map(),reports=new Map(),errors=new Map(),listeners=new Set();
    let client,connecting,stopped=false,generation=0,revision=0,signature=null;
    const snapshot=()=>({revision,registry:registry.snapshot(),restoreAgentComposer,windows:[...reports].map(([targetId,value])=>({targetId,...value})),errors:[...errors.values()]});
    const publish=()=>{
      if(stopped)return;
      const count=[...reports.values()].filter(row=>row.applicable).length;
      context.setHealth({ok:errors.size===0,issueCount:errors.size,message:errors.size?[...errors.values()].map(row=>row.message).join('; '):count?'会话恢复已连接 '+count+' 个主窗口。':'会话恢复已就绪，等待 Codex 主窗口。',
        issues:[...errors].map(([key,error])=>({key,message:error.message})),
        ...(!errors.size?{messageLocales:{en:count?`Session recovery connected to ${count} main windows.`:'Session recovery is ready; waiting for a Codex main window.','zh-Hans':count?'会话恢复已连接 '+count+' 个主窗口。':'会话恢复已就绪，等待 Codex 主窗口。'}}:{})});
      const value=snapshot(),next=JSON.stringify({...value,revision:0});if(next!==signature){signature=next;value.revision=++revision;for(const listener of listeners)listener(value);}
    };
    const failed=(id,error,targetId)=>{
      if(stopped||error.code==='CDP_TARGET_CLOSED')return;
      errors.set(id,{id,targetId,name:error.name,message:error.message,stack:error.stack});
      void context.log({event:'session-failed',id,targetId,name:error.name,message:error.message,stack:error.stack}).catch(error=>console.error('Session diagnostic write failed:',error));publish();
    };
    const evaluate=async(sessionId,expression,timeoutMs)=>{
      const result=await client.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId,timeoutMs);
      if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
      return result.result?.value;
    };
    const install=(targetId,session)=>{
      const work=(session.installing||Promise.resolve()).then(async()=>{
        if(stopped)return;
        if(session.scriptId)await client.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:session.scriptId},session.sessionId);
        const source=sessionPayload({epoch:epoch+':'+generation,registry:registry.snapshot(),restoreAgentComposer,externalKits});
        session.scriptId=(await client.send('Page.addScriptToEvaluateOnNewDocument',{source},session.sessionId)).identifier;
        await evaluate(session.sessionId,source);errors.delete('target:'+targetId);publish();
      });session.installing=work.catch(()=>{/* Each caller reports its original rejection. */});return work;
    };
    const attach=target=>{
      if(stopped||target.type!=='page'||!target.url.startsWith('app://')||sessions.has(target.targetId))return Promise.resolve();
      if(attaching.has(target.targetId))return attaching.get(target.targetId);
      const work=(async()=>{
        const session=await initializePage(client,target.targetId,binding);sessions.set(target.targetId,session);
        await install(target.targetId,session);
      })().catch(error=>failed('target:'+target.targetId,error,target.targetId)).finally(()=>attaching.delete(target.targetId));
      attaching.set(target.targetId,work);return work;
    };
    const remove=id=>{sessions.delete(id);reports.delete(id);for(const [key,error]of errors)if(error.targetId===id)errors.delete(key);publish();};
    const receive=async message=>{
      const params=message.params||{};
      if(['Target.targetCreated','Target.targetInfoChanged'].includes(message.method))return attach(params.targetInfo);
      if(message.method==='Target.targetDestroyed')return remove(params.targetId);
      if(message.method==='Target.detachedFromTarget'){const row=[...sessions].find(([,value])=>value.sessionId===params.sessionId);if(row)remove(row[0]);return;}
      const row=[...sessions].find(([,value])=>value.sessionId===message.sessionId);if(!row)return;
      const [targetId,session]=row;
      if(message.method==='Page.frameNavigated'&&!params.frame.parentId)return install(targetId,session);
      if(message.method!=='Runtime.bindingCalled'||params.name!==binding)return;
      const value=JSON.parse(params.payload);
      if(value.kind==='state'){
        if(typeof value.applicable!=='boolean'||!Array.isArray(value.errors))throw new TypeError('Invalid Session renderer state.');
        reports.set(targetId,value);errors.delete('target:'+targetId);for(const id of errors.keys())if(id.startsWith('renderer:'+targetId+':'))errors.delete(id);
        for(const error of value.errors)errors.set('renderer:'+targetId+':'+error.source,{...error,targetId});publish();
      }else if(value.kind==='runtime-status'){
        const status=value.status;if(typeof status?.ok!=='boolean'||typeof status.threadId!=='string')throw new TypeError('Invalid runtime recovery status.');
        if(registry.snapshot().threads[status.threadId]?.protected!==true)return;
        if(status.ok)errors.delete('runtime:'+status.threadId);else errors.set('runtime:'+status.threadId,{...status,targetId});
        await context.log({event:'thread-runtime-recovery-status',targetId,...status});publish();
      }else throw new TypeError('Unknown Session renderer request.');
    };
    const connect=()=>{
      if(connecting)return connecting;if(client&&!client.closed)return Promise.all(client.targets().map(attach));
      connecting=(async()=>{
        client=await context.cdp.acquire({signal:lifetime.signal});generation++;sessions.clear();reports.clear();errors.delete('cdp');
        for(const [id,error]of errors)if(error.targetId)errors.delete(id);
        client.onError=error=>failed('cdp',error);client.handlers.add(receive);
        await Promise.all(client.targets().map(attach));publish();
      })().catch(error=>{if(!stopped)failed('cdp',error);throw error;}).finally(()=>{connecting=null;});return connecting;
    };
    const unsubscribe=context.cdp.onReconnect(async()=>{await connecting;if(!stopped)return connect();});
    const ensure=async threadId=>{
      if(registry.snapshot().threads[threadId]?.protected!==true)throw new Error('此会话没有显式登记的子线程保护配置。');
      const row=[...reports].find(([id,value])=>value.applicable&&sessions.has(id));if(!row)throw new Error('没有可用的 Codex 主窗口，尚不能验证子线程配置。');
      // Three native requests each have a 5s reply budget; leave 5s for local delivery.
      const result=await evaluate(sessions.get(row[0]).sessionId,'window['+JSON.stringify(key)+'].ensure('+JSON.stringify(threadId)+',{force:true})',20000);
      if(result?.ok!==true||result.skipped)throw new Error('子线程配置未通过读回验证。');return result;
    };
    const syncRegistry=async()=>{
      await Promise.all([...sessions].map(async([id,session])=>{try{await install(id,session);}catch(error){failed('target:'+id,error,id);throw error;}}));
    };
    const register=async body=>{
      const record=await registry.register(body);await syncRegistry();
      await context.log({event:'thread-runtime-registered',threadId:body.threadId,settings:record.settings});publish();
      return{record,status:body.ensure===false?null:await ensure(body.threadId)};
    };
    const unprotect=async threadId=>{
      await Promise.all([...sessions.values()].map(async session=>{await session.installing;await evaluate(session.sessionId,'window['+JSON.stringify(key)+']?.checkUnprotect?.('+JSON.stringify(threadId)+')');}));
      const record=await registry.unprotect(threadId);await syncRegistry();errors.delete('runtime:'+threadId);
      await context.log({event:'thread-runtime-unprotected',threadId});publish();return{threadId,record};
    };
    const prepare=async threadId=>{
      if(!/^[A-Za-z0-9._-]{1,200}$/.test(threadId||''))throw new TypeError('Invalid thread ID.');
      const record=registry.snapshot().threads[threadId];
      const result=record?.protected===true?{threadId,protected:true,kind:record.kind,parentThreadId:record.parentThreadId,route:'multi_agent_v1.send_input',ensured:true,settings:record.settings,status:await ensure(threadId)}
        :{threadId,protected:false,kind:'ordinary-peer-thread',route:'codex_app.send_message_to_thread',ensured:false};
      await context.log({event:'thread-runtime-send-prepared',threadId,protected:result.protected,route:result.route,ensured:result.ensured});return result;
    };
    publish();void connect().catch(()=>{/* connect reports its original failure. */});
    const check=async(recovering=false)=>{await connect();if(recovering&&errors.has('cdp'))await client.send('Browser.getVersion');await Promise.all([...sessions].filter(([id])=>!recovering||[...errors.values()].some(error=>error.targetId===id)).map(async([id,session])=>{try{await install(id,session);await evaluate(session.sessionId,'window['+JSON.stringify(key)+']?.refresh()');}catch(error){failed('target:'+id,error,id);}}));if(!client.closed)errors.delete('cdp');publish();return snapshot();};
    return{check,recover:()=>check(true),modelProtectionHandedOff:externalKits.includes('agent-model-protection'),rulesStateDirectory:path.resolve(context.stateDirectory,'..','..'),management:{title:{en:'Session Recovery','zh-Hans':'会话恢复'},async request({method,url,body}){
      if(method==='GET'&&url.pathname==='/')return{type:'text/html; charset=utf-8',body:page};
      if(method==='GET'&&url.pathname==='/api/state')return{body:snapshot()};
      if(method==='GET'&&url.pathname==='/api/events')return{subscribe(listener){listeners.add(listener);listener(snapshot());return()=>listeners.delete(listener);}};
      if(method==='POST'&&url.pathname==='/api/check')return{body:await check()};
      if(method==='POST'&&url.pathname==='/api/runtime/register')return{body:await register(body)};
      if(method==='POST'&&url.pathname==='/api/runtime/unprotect')return{body:await unprotect(body?.threadId)};
      if(method==='POST'&&url.pathname==='/api/runtime/ensure')return{body:await ensure(body?.threadId)};
      if(method==='POST'&&url.pathname==='/api/runtime/prepare-send')return{body:await prepare(body?.threadId)};
      return null;
    }},async close(){
      stopped=true;unsubscribe();lifetime.abort(new Error('Session plugin stopped.'));await Promise.allSettled([connecting,...attaching.values(),...[...sessions.values()].map(value=>value.installing)]);
      const failures=[];
      if(client&&!client.closed)for(const [id,session]of sessions){try{
        if(session.scriptId)await client.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:session.scriptId},session.sessionId);
        await evaluate(session.sessionId,'window['+JSON.stringify(key)+']?.cleanup()');if(session.bound)await client.send('Runtime.removeBinding',{name:binding},session.sessionId);
      }catch(error){if(error.code!=='CDP_TARGET_CLOSED')failures.push(new Error('Session cleanup failed for '+id,{cause:error}));}}
      try{await client?.close();await registry.close();}catch(error){failures.push(error);}
      listeners.clear();if(failures.length)throw new AggregateError(failures,'Session cleanup failed.');
    }};
  }};
}
