import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import definition from '../kits/role-model-selection/index.mjs';
import { featureModule } from '../../core/src/features.mjs';
import createService from '../src/role-model-service.mjs';
import { readRoleModelControl, applyRoleModelControl } from '../src/role-model-native.mjs';

test('native composer owner is structural, singular and bound to its thread', async () => {
  const calls=[];
  const api={modelSettings:{model:'gpt-6.1-sol',reasoningEffort:'xhigh'},async selectComposerModelAndReasoningEffort(...args){calls.push(args);return true;}};
  const owner={memoizedProps:{conversationId:'thread-a',hasThreadResumeFailed:false},updateQueue:{memoCache:{data:[[api,{modelSelection:api}]]}}};
  const trigger={__reactFiber$test:{memoizedProps:{selectedLabelCandidate:{model:'gpt-6.1-sol',reasoningEffort:'xhigh'}},return:{memoizedProps:{onSelectModel(){},models:[{model:'gpt-6.2-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]},return:owner}}};
  const control=readRoleModelControl(trigger);
  assert.equal(control.threadId,'thread-a');
  await applyRoleModelControl(control,{model:'gpt-6.2-sol',effort:'high'});
  assert.deepEqual(calls[0].slice(0,2),['gpt-6.2-sol','high']);
  assert.deepEqual(calls[0][3],{persistAsDefault:false});
  await assert.rejects(applyRoleModelControl(control,{model:'gpt-6.2-sol',effort:'max'}),/unavailable/);
  owner.updateQueue.memoCache.data[0].push({...api});
  assert.throws(()=>readRoleModelControl(trigger),/owner changed/);
  assert.throws(()=>readRoleModelControl({}),/unavailable/);
});

test('Kit packs its shared calculator and backend without source-tree dependencies',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'role-model-kit-'));
  t.after(()=>fs.rm(directory,{recursive:true}));
  const entry=new URL('../kits/role-model-selection/index.mjs',import.meta.url);
  const packed=spawnSync(process.execPath,[new URL('../../core/src/feature-pack.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),entry.pathname.replace(/^\/(\w:)/,'$1'),directory],{encoding:'utf8',windowsHide:true});
  assert.equal(packed.status,0,packed.stderr);
  const artifact=path.join(directory,definition.manifest.id+'-'+definition.manifest.version);
  const module=await import(pathToFileURL(path.join(artifact,'backend.mjs')).href);
  const store=await module.openRoleModelBackend({filename:path.join(directory,'state','roles.json'),loadInputs:()=>{throw new Error('No live fetch allowed.');}});
  assert.equal(store.snapshot().policy.roles[3].name,'General reviewer');
  assert.equal(store.snapshot().recommendationsValidated,false);
  await store.close();
  assert.equal(definition.manifest.defaultEnabled,false);
  assert.match(featureModule(definition),/createRoleModelSelection/);
});

test('service keeps per-page receipts, refreshes unvalidated saved data, and reports original failures',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'role-model-service-'));
  t.after(()=>fs.rm(directory,{recursive:true}));
  const filename=path.join(directory,'backend.mjs');
  await fs.writeFile(filename,`export async function openRoleModelBackend({onChange,onError}) {
    let error,validated=false,refreshes=0,assignments={};
    const snapshot=()=>({policy:{roles:[]},assignments,recommendations:{selections:{}},recommendationsValidated:validated,error,refreshes});
    return {snapshot,assign:async({hostId,threadId,roleId})=>{assignments[JSON.stringify([hostId,threadId])]=roleId;onChange();},savePolicy:async value=>{if(value.fail){error=new TypeError('original role error');onError(error);throw error;}error=undefined;},refresh:async()=>{refreshes++;validated=true;onChange();},close:async()=>{}};
  }`,{encoding:'utf8'});
  const errors=new Map();let notifications=0;
  const service=await createService({}, {stateDirectory:directory,notify:async()=>notifications++,reportError:(error,key)=>error?errors.set(key,error):errors.delete(key)});
  const catalog=[{directory,manifest:{id:'role-model-selection',backendEntry:'backend.mjs'}}];
  await service.configure(['role-model-selection'],catalog);await Promise.resolve();
  assert.equal(service.snapshot('one').roleModels.refreshes,1);
  await service.receive('one',{kind:'role-model-action',requestId:'1',operation:'assign',value:{hostId:'local',threadId:'one',roleId:'responder'}});
  assert.deepEqual(service.snapshot('one').roleModels.receipt,{requestId:'1',ok:true});
  assert.equal(service.snapshot('two').roleModels.receipt,null);
  await service.receive('one',{kind:'role-model-action',requestId:'2',operation:'policy',value:{fail:true}});
  assert.equal(service.snapshot('one').roleModels.receipt.ok,false);
  assert.ok(errors.get('action:one') instanceof TypeError);
  await service.receive('one',{kind:'role-model-action',requestId:'3',operation:'policy',value:{}});
  assert.equal(errors.has('action:one'),false);assert.equal(errors.has('recommendations'),false);
  service.removeTarget('one');assert.equal(service.snapshot('one').roleModels.receipt,null);
  assert.ok(notifications>0);await service.close();
});
