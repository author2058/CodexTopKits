import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeRuntimeSettings as normalize,sameRuntimeSettings as same,createRuntimeGuard } from '../src/runtime-settings.mjs';
import { openRuntimeRegistry } from '../src/registry.mjs';

const desired={model:'luna',effort:'xhigh',serviceTier:'priority'};
const registry={version:2,threads:{child:{protected:true,settings:desired}}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('complete runtime tuple restores atomically, reads back and never changes the baseline',async()=>{
  const calls=[],statuses=[];let actual={model:'parent',effort:'medium',serviceTier:null};
  const guard=createRuntimeGuard(async(method,params)=>{calls.push({method,params});if(method==='thread/settings/update')actual={model:params.model,effort:params.effort,serviceTier:params.serviceTier};return actual;},registry,value=>statuses.push(value),normalize,same);
  const first=guard.ensure('child'),second=guard.ensure('child');assert.equal(first,second);
  assert.equal((await first).stage,'restored');
  assert.deepEqual(calls.map(row=>row.method),['thread/resume','thread/settings/update','thread/resume']);
  assert.deepEqual(calls[1].params,{threadId:'child',...desired});assert.deepEqual(registry.threads.child.settings,desired);
  await guard.ensure('ordinary');assert.equal(calls.length,3);await guard.ensure('child');assert.equal(calls.length,3);
  actual={model:'parent',effort:'medium',serviceTier:null};guard.receive('thread/resumed',{threadId:'child'});await tick();assert.equal(calls.length,6);assert.deepEqual(actual,desired);
  guard.cleanup();await assert.rejects(guard.ensure('child'),/stopped/);
});
test('unexpected native failure retains identity, gates repeated sends, and only explicit retry proceeds',async()=>{
  const original=Object.assign(new TypeError('Native schema changed'),{code:'NATIVE_SCHEMA'});let calls=0,broken=true;const statuses=[];
  const guard=createRuntimeGuard(async()=>{calls++;if(broken)throw original;return desired;},registry,value=>statuses.push(value),normalize,same);
  await assert.rejects(guard.ensure('child'),error=>error===original);await assert.rejects(guard.ensure('child'),error=>error===original);
  guard.receive('thread/resumed',{threadId:'child'});await tick();assert.equal(calls,1);assert.equal(statuses[0].error.stack,original.stack);
  broken=false;assert.equal((await guard.ensure('child',{force:true})).ok,true);assert.equal(calls,2);
});
test('incorrect readback and a baseline edited during recovery never authorize a send',async()=>{
  const wrong=createRuntimeGuard(async()=>({model:'wrong',effort:'high',serviceTier:null}),registry,()=>{},normalize,same);
  await assert.rejects(wrong.ensure('child'),error=>error.runtimeSettings.desired===desired||error.message.includes('readback'));
  let release;const delayed=createRuntimeGuard(()=>new Promise(resolve=>release=resolve),registry,()=>{},normalize,same);
  const pending=delayed.ensure('child');delayed.update({version:2,threads:{child:{protected:true,settings:{...desired,effort:'high'}}}});release(desired);
  await assert.rejects(pending,/changed during recovery/);
});
test('pending model verification remains visible until the native request finishes',async()=>{
  let release;const guard=createRuntimeGuard(()=>new Promise(resolve=>{release=resolve;}),registry,()=>{},normalize,same);
  const pending=guard.ensure('child');assert.equal(guard.busy(),true);release(desired);await pending;assert.equal(guard.busy(),false);guard.cleanup();
});

test('ending protection during a native read prevents a stale settings write',async()=>{
  const calls=[];let release;
  const guard=createRuntimeGuard((method)=>{calls.push(method);return new Promise(resolve=>{release=resolve;});},registry,()=>{},normalize,same);
  const pending=guard.ensure('child');
  guard.update({threads:{child:{protected:false,settings:desired}}});
  release({model:'parent',effort:'low',serviceTier:null});
  await assert.rejects(pending,/changed during recovery/);assert.deepEqual(calls,['thread/resume']);
  assert.equal((await guard.ensure('child')).skipped,true);guard.cleanup();
});
test('fast aliases and nullable fields normalize without protecting observed records',async()=>{
  assert.deepEqual(normalize({threadSettings:{model:' luna ',reasoning_effort:'xhigh',service_tier:'fast'}}),desired);
  assert.deepEqual(normalize({model:'luna',effort:null,serviceTier:null}),{model:'luna',effort:null,serviceTier:null});
  let calls=0;const guard=createRuntimeGuard(async()=>{calls++;return desired;},{threads:{observed:{settings:desired,protected:false}}},()=>{},normalize,same);
  guard.receive('thread/settings/updated',{threadId:'observed',...desired});await guard.ensure('observed');assert.equal(calls,0);
});
test('registry creates its own directory, persists complete explicit settings, and keeps concurrent writes',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cdtk-session-'));t.after(()=>fs.rm(folder,{recursive:true}));
  const filename=path.join(folder,'new','runtime.json'),store=await openRuntimeRegistry(filename);
  assert.throws(()=>store.register({threadId:'child',settings:{model:'luna'}}),/requires model/);
  await Promise.all([store.register({threadId:'child',parentThreadId:'parent',settings:desired}),store.register({threadId:'other',settings:{...desired,serviceTier:'fast'}})]);
  const fresh=await openRuntimeRegistry(filename);assert.equal(Object.keys(fresh.snapshot().threads).length,2);assert.equal(fresh.snapshot().threads.child.protected,true);assert.equal(fresh.snapshot().threads.other.settings.serviceTier,'priority');
  const clone=fresh.snapshot();clone.threads.child.settings.model='mutated';assert.equal(fresh.snapshot().threads.child.settings.model,'luna');await store.close();await fresh.close();
});
test('v1 observation registry is not silently protected and malformed state is not replaced',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cdtk-session-'));t.after(()=>fs.rm(folder,{recursive:true}));const filename=path.join(folder,'registry.json');
  await fs.writeFile(filename,JSON.stringify({version:1,threads:{old:{...desired,protected:true}}}),'utf8');const store=await openRuntimeRegistry(filename);assert.equal(store.snapshot().threads.old.protected,false);
  await fs.writeFile(filename,'{"broken":','utf8');await assert.rejects(openRuntimeRegistry(filename),SyntaxError);assert.equal(await fs.readFile(filename,'utf8'),'{"broken":');
});

test('unprotect preserves recorded settings, serializes with registration and persists without deleting chats',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cdtk-session-unprotect-'));t.after(()=>fs.rm(folder,{recursive:true}));
  const filename=path.join(folder,'registry.json'),store=await openRuntimeRegistry(filename);
  await store.register({threadId:'child',parentThreadId:'parent',settings:desired});
  const [record]=await Promise.all([store.unprotect('child'),store.register({threadId:'other',settings:desired})]);
  assert.equal(record.protected,false);assert.equal(record.kind,null);assert.equal(record.parentThreadId,'parent');assert.deepEqual(record.settings,desired);
  const fresh=await openRuntimeRegistry(filename);assert.equal(fresh.snapshot().threads.child.protected,false);assert.equal(fresh.snapshot().threads.other.protected,true);
  assert.deepEqual(await store.unprotect('child'),record);
  await assert.rejects(store.unprotect('unknown'),/Unknown runtime protection/);
  assert.throws(()=>store.unprotect('../child'),/Invalid thread ID/);
  await store.close();await fresh.close();
});
