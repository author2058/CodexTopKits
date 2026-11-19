#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { requestRuntime } from 'codex-toolkit-core/runtime';
import { installRules,removeRules,rulesStatus } from './integration.mjs';

export async function run(argv,defaults={}){
  const {values,positionals}=parseArgs({args:argv,allowPositionals:true,strict:true,options:{
    'state-directory':{type:'string'},'codex-home':{type:'string'},powershell:{type:'string'},
    'thread-id':{type:'string'},'parent-thread-id':{type:'string'},model:{type:'string'},effort:{type:'string'},'service-tier':{type:'string'},'no-ensure':{type:'boolean',default:false},
  }});
  if(positionals.length!==1)throw new TypeError('Choose register, unprotect, ensure, prepare-send, show, install-rules, remove-rules or rules-status.');
  const [action]=positionals,stateDirectory=values['state-directory']??defaults.stateDirectory;
  if(!path.isAbsolute(stateDirectory??''))throw new TypeError('Specify the absolute Core state directory with --state-directory.');
  const installation={'install-rules':installRules,'remove-rules':removeRules,'rules-status':rulesStatus};
  if(Object.hasOwn(installation,action))return installation[action]({codexHome:values['codex-home'],stateDirectory,powershell:values.powershell});
  if(!['register','unprotect','ensure','prepare-send','show'].includes(action))throw new TypeError('Unknown Session Recovery command: '+action);
  const runtime=await requestRuntime(stateDirectory,'status');
  if(runtime.phase!=='running'||!runtime.managerUrl)throw new Error('Codex Desktop Toolkit is not running. Start it with SessionRecovery enabled.');
  let suffix='/api/state',method='GET',body;
  if(action!=='show'){
    const threadId=values['thread-id'];if(!/^[A-Za-z0-9._-]{1,200}$/.test(threadId??''))throw new TypeError('Specify --thread-id.');
    body={threadId};method='POST';suffix='/api/runtime/'+action;
    if(action==='register'){
      if(!values.model||!Object.hasOwn(values,'effort')||!Object.hasOwn(values,'service-tier'))throw new TypeError('Registration requires --model, --effort and --service-tier. Use null to clear effort or tier.');
      body={...body,parentThreadId:values['parent-thread-id']??null,settings:{model:values.model,effort:values.effort==='null'?null:values.effort,serviceTier:values['service-tier']==='null'?null:values['service-tier']},ensure:!values['no-ensure']};
    }
  }
  const response=await fetch(new URL('plugins/session'+suffix,runtime.managerUrl),{method,headers:{'content-type':'application/json','x-codex-toolkit-action':'manage'},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.error?.message??result.error??'Session Recovery request failed.'),typeof result.error==='object'?result.error:{});
  return result;
}
export async function main(argv=process.argv.slice(2),defaults={}){try{console.log(JSON.stringify(await run(argv,defaults)));}catch(error){console.error(error);process.exitCode=1;}}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
