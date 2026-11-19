export function installSessionRenderer(window, initial, helpers) {
  const key='__CODEX_DESKTOP_TOOLKIT_SESSION__', binding='__CDTK_SESSION_BRIDGE__', document=window.document;
  if(window!==window.top)return {applicable:false};
  if(window.__CODEX_DYNAMIC_THEME__)throw new Error('旧控制器仍在此页面运行；请先停止旧注入，再启用会话恢复。');
  if(initial.restoreAgentComposer&&window.__CODEXTOPKITS_AGENT_COMPOSER__)throw new Error('The agent composer Kit already owns this page.');
  const externalGuard=initial.externalKits?.includes('agent-model-protection')===true;
  if(!externalGuard&&window.__CODEXTOPKITS_AGENT_MODEL_PROTECTION__)throw new Error('The agent model protection Kit already owns this page.');
  if(window[key]?.epoch===initial.epoch)return window[key].setRegistry(initial.registry);
  window[key]?.cleanup();
  if(document.readyState==='loading'){
    let latest=initial;
    const start=()=>{delete window[key];try{installSessionRenderer(window,latest,helpers);}catch(error){window[binding](JSON.stringify({kind:'state',applicable:false,errors:[{source:'startup',name:error.name,message:error.message,stack:error.stack}]}));}};
    window[key]={epoch:initial.epoch,handoffs:{agentComposer:!initial.restoreAgentComposer,modelProtection:externalGuard},setRegistry(registry){latest={...latest,registry};},cleanup(){document.removeEventListener('DOMContentLoaded',start);delete window[key];}};
    document.addEventListener('DOMContentLoaded',start,{once:true});return {pending:true};
  }
  const {createNativeBridgeClient,readNativeNotification,readNativeConversationIdentity,normalizeRuntimeSettings,sameRuntimeSettings,createRuntimeGuard,installAgentComposerRestore,createNativeAssetReader}=helpers;
  const bridge=createNativeBridgeClient(window),errors=new Map();let stopped=false,scheduled=false,signature=null,restorer,registry=initial.registry;
  const external=()=>window.__CODEXTOPKITS_AGENT_MODEL_PROTECTION__;
  const checkUnprotect=id=>{
    const owner=external();
    if(externalGuard&&registry?.threads?.[id]?.protected===true&&owner&&owner.supportsProtectionRelease!==true)throw new Error('Update Agent Model Protection to 0.1.3 or later, or disable it in Kits before ending protection.');
    return true;
  };
  const applicable=()=>window.location.pathname!=='/detached-window.html'&&[...document.querySelectorAll('main.main-surface,main[class*="MainContentSurface"]')].some(node=>!node.closest('[data-app-shell-tab-panel-controller="right"]'));
  const send=value=>{if(!stopped){if(typeof window[binding]!=='function')throw new Error('会话恢复的控制器连接不可用。');window[binding](JSON.stringify(value));}};
  const report=()=>{
    const value={kind:'state',applicable:applicable(),errors:[...errors].map(([source,error])=>({source,name:error.name,message:error.message,stack:error.stack})),runtime:guard?.status()||external()?.status()||[],agentComposer:restorer?.status()||null};
    const next=JSON.stringify(value);if(next!==signature){signature=next;send(value);}return value;
  };
  const failed=source=>error=>{if(!stopped){errors.set(source,error);report();}};
  const reportRuntimeStatus=status=>{send({kind:'runtime-status',status});report();};
  const guard=externalGuard?null:createRuntimeGuard((method,params,source)=>bridge.appServer(method,params,{source}),initial.registry,reportRuntimeStatus,normalizeRuntimeSettings,sameRuntimeSettings);
  const refresh=()=>{
    if(stopped)return;
    if(applicable()){
      const ids=new Set([...document.querySelectorAll('[data-above-composer-conversation-id]')].filter(node=>(node.closest('[data-codex-composer-root]')||node.parentElement)?.getClientRects().length).map(node=>node.getAttribute('data-above-composer-conversation-id')?.replace(/^local:/,'')));
      for(const panel of document.querySelectorAll('[role="tabpanel"][data-tab-id^="background-agent:"],[role="tabpanel"][data-tab-id^="sidechat:"]')) if(panel.getClientRects().length)ids.add(panel.getAttribute('data-tab-id').split(':').at(-1));
      if(guard)for(const id of ids) if(id)void guard.ensure(id).catch(()=>{/* The guard has already reported the original failure. */});
      if(initial.restoreAgentComposer&&!restorer)restorer=installAgentComposerRestore(document,bridge,createNativeAssetReader(document),failed('agent-composer'),report,readNativeConversationIdentity);
      restorer?.refresh();
    }
    report();
  };
  const schedule=()=>{if(!scheduled&&!stopped){scheduled=true;window.queueMicrotask(()=>{scheduled=false;try{refresh();}catch(error){failed('renderer')(error);}});}};
  const watch='main,[class*="_Workspace_"],[data-above-composer-conversation-id],[role="tabpanel"][data-tab-id]';
  const observer=new window.MutationObserver(records=>{if(records.some(record=>record.type==='attributes'?record.target.matches?.(watch):[...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1&&(node.matches(watch)||node.querySelector(watch)))))schedule();});
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-above-composer-conversation-id','data-tab-id','hidden','aria-hidden','class','style']});
  const receive=event=>{
    if(event.source&&event.source!==window||event.data?.type!=='mcp-notification'||event.data.hostId&&event.data.hostId!=='local')return;
    if(!guard)return;
    try{const {method,params}=readNativeNotification(event.data);guard.receive(method,params);}catch(error){failed('runtime-event')(error);}
  };
  window.addEventListener('message',receive);
  const api=window[key]={epoch:initial.epoch,handoffs:{agentComposer:!initial.restoreAgentComposer,modelProtection:externalGuard},getRegistry:()=>registry,checkUnprotect,reportRuntimeStatus,setRegistry(value){for(const[id,record]of Object.entries(registry?.threads||{}))if(record.protected===true&&value?.threads?.[id]?.protected!==true)checkUnprotect(id);registry=value;guard?.update(value);if(externalGuard)external()?.update(value);schedule();return true;},ensure:(threadId,options)=>externalGuard?(external()?.ensure(threadId,options)||Promise.reject(new Error('Agent model protection Kit is not running.'))):guard.ensure(threadId,options),refresh(){refresh();return report();},cleanup(){stopped=true;observer.disconnect();guard?.cleanup();restorer?.cleanup();bridge.close();window.removeEventListener('message',receive);delete window[key];}};
  if(externalGuard)window.dispatchEvent(new Event('codextopkits-session-ready'));
  schedule();return api.refresh();
}
