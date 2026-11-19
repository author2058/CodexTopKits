import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const decode=bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function optional(filename){try{return await fs.readFile(filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function writeJson(filename,value){await fs.mkdir(path.dirname(filename),{recursive:true});const temporary=filename+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n','utf8');await fs.rename(temporary,filename);}
function locations({codexHome,stateDirectory}){
  if(![codexHome,stateDirectory].every(value=>path.isAbsolute(value??'')))throw new TypeError('Specify absolute Codex home and Core state directories.');
  codexHome=path.resolve(codexHome);stateDirectory=path.resolve(stateDirectory);
  return{codexHome,stateDirectory,hooksFile:path.join(codexHome,'hooks.json'),receiptFile:path.join(stateDirectory,'plugins','session','rules-integration.json')};
}
function ownedPaths(files){return[
  path.join(files.codexHome,'skills','context-recovery','SKILL.md'),path.join(files.codexHome,'skills','context-recovery','scripts','recover-breakpoint.mjs'),
  path.join(files.codexHome,'skills','codex-thread-runtime','SKILL.md'),path.join(files.codexHome,'skills','codex-thread-runtime','scripts','thread-runtime.mjs'),
  path.join(files.codexHome,'hooks','toolkit-session','Invoke-ContextRecovery.ps1'),
];}
async function receiptAt(files){const bytes=await optional(files.receiptFile);if(!bytes)return null;const receipt=JSON.parse(decode(bytes));if(receipt.codexHome!==files.codexHome||receipt.stateDirectory!==files.stateDirectory||receipt.version!==1||!Array.isArray(receipt.artifacts)||receipt.artifacts.length!==5||new Set(receipt.artifacts.map(row=>row.filename)).size!==5||receipt.artifacts.some(row=>!ownedPaths(files).includes(row.filename)))throw new Error('Session rules receipt does not match this installation.');return receipt;}
function groupsAt(config){if(!config.hooks||typeof config.hooks!=='object'||Array.isArray(config.hooks))throw new TypeError('Invalid hooks.json hooks object.');const groups=config.hooks.SessionStart??[];if(!Array.isArray(groups))throw new TypeError('Invalid SessionStart Hook groups.');return groups;}
const isRecovery=group=>group.hooks?.some(hook=>/Invoke-ContextRecovery\.ps1/i.test(hook.commandWindows??hook.command??''));
async function verifyArtifacts(receipt){for(const artifact of receipt?.artifacts??[]){const bytes=await optional(artifact.filename);if(bytes&&hash(bytes)!==artifact.hash)throw new Error('Session rules have local edits; nothing was overwritten or removed: '+artifact.filename);}}

export async function rulesStatus(options){
  const files=locations(options),receipt=await receiptAt(files);
  if(!receipt)return{installed:false,...files,trust:'not-checked'};
  const bytes=await optional(files.hooksFile),groups=bytes?groupsAt(JSON.parse(decode(bytes))):[];
  const artifacts=await Promise.all(receipt.artifacts.map(async artifact=>{const bytes=await optional(artifact.filename);return{filename:artifact.filename,present:!!bytes,matches:!!bytes&&hash(bytes)===artifact.hash};}));
  return{installed:groups.some(group=>same(group,receipt.group))&&artifacts.every(row=>row.matches),...files,artifacts,trust:'not-checked',installedAt:receipt.installedAt};
}

export async function installRules(options){
  const files=locations(options),nodeExecutable=options.nodeExecutable??process.execPath,powershell=options.powershell;
  if(![nodeExecutable,powershell].every(value=>path.isAbsolute(value??'')))throw new TypeError('Specify absolute standalone Node and PowerShell 7 executables.');
  const assetRoot=options.assetRoot??root,runtimeCliPath=options.runtimeCliPath??path.join(root,'src','cli.mjs');
  if(![assetRoot,runtimeCliPath].every(value=>path.isAbsolute(value??'')))throw new TypeError('Specify absolute Session artifact and CLI paths.');
  const previous=await receiptAt(files),original=await optional(files.hooksFile),config=original?JSON.parse(decode(original)):{hooks:{}};
  const groups=groupsAt(config),kept=groups.filter(group=>!previous||!same(group,previous.group));
  if(kept.some(isRecovery))throw new Error('Another context recovery Hook already exists. Keep or remove that installation explicitly before installing these rules.');
  await verifyArtifacts(previous);
  const recoveryRoot=path.join(files.codexHome,'skills','context-recovery'),runtimeRoot=path.join(files.codexHome,'skills','codex-thread-runtime');
  const recoveryScript=path.join(recoveryRoot,'scripts','recover-breakpoint.mjs'),runtimeScript=path.join(runtimeRoot,'scripts','thread-runtime.mjs');
  const hookScript=path.join(files.codexHome,'hooks','toolkit-session','Invoke-ContextRecovery.ps1');
  const recoveryTemplate=await fs.readFile(path.join(assetRoot,'assets','context-recovery','SKILL.md'),'utf8');
  const runtimeTemplate=await fs.readFile(path.join(assetRoot,'assets','thread-runtime-skill.md'),'utf8');
  const artifacts=[
    {filename:path.join(recoveryRoot,'SKILL.md'),content:recoveryTemplate.replaceAll('{{NODE}}',quote(nodeExecutable)).replaceAll('{{RECOVERY_SCRIPT}}',recoveryScript.replaceAll("'","''"))},
    {filename:recoveryScript,content:await fs.readFile(path.join(assetRoot,'assets','context-recovery','scripts','recover-breakpoint.mjs'))},
    {filename:path.join(runtimeRoot,'SKILL.md'),content:runtimeTemplate.replaceAll('{{NODE}}',quote(nodeExecutable)).replaceAll('{{RUNTIME_SCRIPT}}',runtimeScript.replaceAll("'","''"))},
    {filename:runtimeScript,content:'import { main } from '+JSON.stringify(pathToFileURL(runtimeCliPath).href)+';\nawait main(process.argv.slice(2), '+JSON.stringify({stateDirectory:files.stateDirectory})+');\n'},
    {filename:hookScript,content:await fs.readFile(path.join(assetRoot,'assets','Invoke-ContextRecovery.ps1'))},
  ];
  if(options.preserveRuntime&&previous)for(const artifact of artifacts.filter(row=>row.filename===path.join(runtimeRoot,'SKILL.md')||row.filename===runtimeScript)){
    const existing=await optional(artifact.filename);if(existing)artifact.content=existing;
  }
  for(const artifact of artifacts){const bytes=await optional(artifact.filename);if(bytes&&!previous?.artifacts.some(row=>row.filename===artifact.filename))throw new Error('An existing skill or Hook is not owned by this installation; nothing was changed: '+artifact.filename);}
  const command=`& ${quote(powershell)} -NoLogo -NoProfile -NonInteractive -File ${quote(hookScript)}`;
  const statusMessage=previous?.group?.hooks?.[0]?.statusMessage??'恢复压缩后的现场';
  const group={matcher:'^compact$',hooks:[{type:'command',command,commandWindows:command,timeout:10,additionalContextLimit:2000,statusMessage}]};
  if(previous&&same(previous.group,group)&&artifacts.every(artifact=>previous.artifacts.some(row=>row.filename===artifact.filename&&row.hash===hash(artifact.content)))){
    const status=await rulesStatus(files);if(status.installed)return status;
  }
  if(!same(original?.toString('base64'),(await optional(files.hooksFile))?.toString('base64')))throw new Error('hooks.json changed during installation; no changes were written.');
  await fs.mkdir(path.dirname(files.receiptFile),{recursive:true});
  if(original)await fs.writeFile(path.join(path.dirname(files.receiptFile),'hooks-before-'+randomUUID()+'.json'),original);
  for(const artifact of artifacts){
    const existing=await optional(artifact.filename),next=Buffer.isBuffer(artifact.content)?artifact.content:Buffer.from(artifact.content,'utf8');
    if(!existing?.equals(next)){await fs.mkdir(path.dirname(artifact.filename),{recursive:true});await fs.writeFile(artifact.filename,next);}
  }
  config.hooks.SessionStart=[...kept,group];await writeJson(files.hooksFile,config);
  await writeJson(files.receiptFile,{version:1,codexHome:files.codexHome,stateDirectory:files.stateDirectory,group,artifacts:artifacts.map(row=>({filename:row.filename,hash:hash(row.content)})),installedAt:new Date().toISOString()});
  return rulesStatus(files);
}

export async function disableRecoveryHook(options){
  const files=locations(options),receipt=await receiptAt(files);if(!receipt)return{disabled:false,reason:'No installation receipt; nothing was changed.'};
  const original=await optional(files.hooksFile);if(!original)return{disabled:false,reason:'Recovery Hook is not configured.'};
  const config=JSON.parse(decode(original)),groups=groupsAt(config),kept=groups.filter(group=>!same(group,receipt.group));
  if(kept.some(isRecovery))throw new Error('The context recovery Hook differs from the installed receipt; nothing was changed.');
  if(kept.length===groups.length)return{disabled:false,reason:'Recovery Hook is not configured.'};
  if(!same(original.toString('base64'),(await optional(files.hooksFile))?.toString('base64')))throw new Error('hooks.json changed during update; no changes were written.');
  await fs.writeFile(path.join(path.dirname(files.receiptFile),'hooks-before-'+randomUUID()+'.json'),original);
  config.hooks.SessionStart=kept;await writeJson(files.hooksFile,config);
  return{disabled:true,retained:'Installed skills, protection settings, backups, Codex trust state and unrelated configuration were not removed.'};
}

export async function removeRules(options){
  const files=locations(options),receipt=await receiptAt(files);if(!receipt)return{removed:false,reason:'No installation receipt; nothing was changed.'};
  await verifyArtifacts(receipt);
  const original=await optional(files.hooksFile),config=original?JSON.parse(decode(original)):{hooks:{}};
  const groups=groupsAt(config),kept=groups.filter(group=>!same(group,receipt.group));
  if(kept.some(isRecovery))throw new Error('The context recovery Hook differs from the installed receipt; nothing was removed.');
  if(original&&kept.length!==groups.length){await fs.writeFile(path.join(path.dirname(files.receiptFile),'hooks-before-'+randomUUID()+'.json'),original);config.hooks.SessionStart=kept;await writeJson(files.hooksFile,config);}
  for(const artifact of receipt.artifacts)if(await optional(artifact.filename))await fs.unlink(artifact.filename);
  await fs.unlink(files.receiptFile);
  return{removed:true,retained:'Protection settings, backups, Codex trust state and unrelated configuration were not removed.'};
}
