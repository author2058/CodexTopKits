import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installRules,removeRules,rulesStatus,disableRecoveryHook } from '../src/integration.mjs';

async function fixture(t){const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cdtk-session-rules-'));t.after(()=>fs.rm(folder,{recursive:true}));const options={codexHome:path.join(folder,'用户 Codex'),stateDirectory:path.join(folder,'toolkit'),powershell:process.execPath};await fs.mkdir(options.codexHome,{recursive:true});return{folder,options,hooks:path.join(options.codexHome,'hooks.json')};}
test('installation is isolated, preserves other Hooks and trust, and removal owns exact files only',async t=>{
  const {options,hooks}=await fixture(t),other={matcher:'view_image',hooks:[{type:'command',command:'existing'}]},trust={trusted:['unrelated']};
  await fs.writeFile(hooks,JSON.stringify({hooks:{PreToolUse:[other],SessionStart:[]},trust}),'utf8');
  const result=await installRules(options);assert.equal(result.installed,true);assert.equal(result.trust,'not-checked');assert.equal(result.artifacts.length,5);
  let config=JSON.parse(await fs.readFile(hooks,'utf8'));assert.deepEqual(config.hooks.PreToolUse,[other]);assert.deepEqual(config.trust,trust);assert.equal(config.hooks.SessionStart[0].matcher,'^compact$');
  const wrapper=await fs.readFile(result.artifacts.find(row=>row.filename.endsWith('thread-runtime.mjs')).filename,'utf8');assert.match(wrapper,/stateDirectory/);assert.match(wrapper,/src\/cli.mjs/);
  const skill=await fs.readFile(result.artifacts.find(row=>row.filename.endsWith('context-recovery'+path.sep+'SKILL.md')).filename,'utf8');assert.doesNotMatch(skill,/\{\{NODE\}\}|\{\{RECOVERY_SCRIPT\}\}/);assert.match(skill,/upper bound/);
  assert.equal((await installRules(options)).installed,true);assert.equal((await rulesStatus(options)).installed,true);
  const unrelated=path.join(options.codexHome,'skills','context-recovery','notes.txt');await fs.writeFile(unrelated,'retain','utf8');
  assert.equal((await removeRules(options)).removed,true);assert.equal(await fs.readFile(unrelated,'utf8'),'retain');config=JSON.parse(await fs.readFile(hooks,'utf8'));assert.deepEqual(config.hooks.PreToolUse,[other]);assert.deepEqual(config.trust,trust);assert.deepEqual(config.hooks.SessionStart,[]);
});
test('disabling recovery removes only its Hook and leaves child runtime protection intact',async t=>{
  const {options,hooks}=await fixture(t),other={matcher:'view_image',hooks:[{type:'command',command:'existing'}]},trust={trusted:['other']};
  await fs.writeFile(hooks,JSON.stringify({hooks:{PreToolUse:[other],SessionStart:[]},trust}),'utf8');
  const installed=await installRules(options),runtime=installed.artifacts.find(row=>row.filename.endsWith('codex-thread-runtime'+path.sep+'SKILL.md')).filename,before=await fs.readFile(runtime,'utf8');
  const backups=async()=> (await fs.readdir(path.dirname(installed.receiptFile))).filter(name=>name.startsWith('hooks-before-')).length;
  const count=await backups();await installRules(options);assert.equal(await backups(),count);
  assert.equal((await disableRecoveryHook(options)).disabled,true);assert.equal(await fs.readFile(runtime,'utf8'),before);assert.equal((await rulesStatus(options)).installed,false);
  let config=JSON.parse(await fs.readFile(hooks,'utf8'));assert.deepEqual(config.hooks.PreToolUse,[other]);assert.deepEqual(config.hooks.SessionStart,[]);assert.deepEqual(config.trust,trust);
  assert.equal((await installRules(options)).installed,true);assert.equal(await fs.readFile(runtime,'utf8'),before);
  config=JSON.parse(await fs.readFile(hooks,'utf8'));assert.equal(config.hooks.SessionStart.length,1);
});
test('updating the recovery Hook preserves its existing status message',async t=>{
  const {options,hooks}=await fixture(t),installed=await installRules(options);
  const config=JSON.parse(await fs.readFile(hooks,'utf8')),receipt=JSON.parse(await fs.readFile(installed.receiptFile,'utf8'));
  config.hooks.SessionStart[0].hooks[0].statusMessage='Existing recovery status';receipt.group=config.hooks.SessionStart[0];
  await fs.writeFile(hooks,JSON.stringify(config),'utf8');await fs.writeFile(installed.receiptFile,JSON.stringify(receipt),'utf8');
  await installRules(options);
  assert.equal(JSON.parse(await fs.readFile(hooks,'utf8')).hooks.SessionStart[0].hooks[0].statusMessage,'Existing recovery status');
});
test('existing skills and modified owned files are not overwritten or removed',async t=>{
  const {options,hooks}=await fixture(t),skill=path.join(options.codexHome,'skills','codex-thread-runtime','SKILL.md');await fs.mkdir(path.dirname(skill),{recursive:true});await fs.writeFile(skill,'foreign','utf8');
  await assert.rejects(installRules(options),/not owned/);assert.equal(await fs.readFile(skill,'utf8'),'foreign');await assert.rejects(fs.stat(hooks),{code:'ENOENT'});
  await fs.unlink(skill);const result=await installRules(options);await fs.writeFile(skill,'local edit','utf8');const before=await fs.readFile(hooks,'utf8');
  await assert.rejects(installRules(options),/local edits/);await assert.rejects(removeRules(options),/local edits/);assert.equal(await fs.readFile(hooks,'utf8'),before);assert.equal((await rulesStatus(options)).installed,false);assert.equal(result.installed,true);
});
test('foreign recovery Hook, invalid UTF-8 and BOM JSON remain visible errors',async t=>{
  const {options,hooks}=await fixture(t);await fs.writeFile(hooks,JSON.stringify({hooks:{SessionStart:[{hooks:[{command:'old/Invoke-ContextRecovery.ps1'}]}]}}),'utf8');await assert.rejects(installRules(options),/Another context/);
  await fs.writeFile(hooks,Buffer.from([0xff]));await assert.rejects(installRules(options),TypeError);
  await fs.writeFile(hooks,'\uFEFF{"hooks":{}}','utf8');await assert.rejects(installRules(options),SyntaxError);
});
test('a modified receipt cannot remove a file outside this integration',async t=>{
  const {options,folder}=await fixture(t),result=await installRules(options),foreign=path.join(folder,'keep.txt');await fs.writeFile(foreign,'keep','utf8');
  const receipt=JSON.parse(await fs.readFile(result.receiptFile,'utf8'));receipt.artifacts[0].filename=foreign;await fs.writeFile(result.receiptFile,JSON.stringify(receipt),'utf8');await assert.rejects(removeRules(options),/receipt/);assert.equal(await fs.readFile(foreign,'utf8'),'keep');
});
test('the real PowerShell Hook emits UTF-8 compact context and rejects other sources',{skip:process.platform!=='win32'},()=>{
  const args=['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../assets/Invoke-ContextRecovery.ps1',import.meta.url))];
  const invoke=source=>spawnSync(process.env.CDTK_TEST_POWERSHELL||'pwsh.exe',args,{input:JSON.stringify({hook_event_name:'SessionStart',source,session_id:'fixture-中文',turn_id:'turn'}),encoding:'utf8',windowsHide:true});
  const accepted=invoke('compact');assert.equal(accepted.status,0,accepted.stderr);assert.ok(!accepted.stdout.startsWith('\uFEFF'));const result=JSON.parse(accepted.stdout);assert.equal(result.continue,true);assert.equal(result.hookSpecificOutput.hookEventName,'SessionStart');assert.match(result.hookSpecificOutput.additionalContext,/fixture-中文/);assert.match(result.hookSpecificOutput.additionalContext,/hook_observed_at=\d{4}-\d\d-\d\dT/);
  const rejected=invoke('startup');assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/Unexpected hook payload/);
});
