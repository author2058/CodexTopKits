import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { nativeQuitItem, installRestartMenu } from '../src/application-menu.mjs';
import { startAppRestart } from '../src/restart.mjs';
import { featureModule } from '../src/features.mjs';
import kit from '../kits/app-restart/index.mjs';

const snapshot = () => ({ 'file-menu': [{ type: 'item', nativeCommandId: 1, label: 'New Window' }, { type: 'item', nativeCommandId: 5, label: 'Quit ChatGPT', enabled: true }], 'edit-menu': [] });
test('restart is immediately before Quit; native snapshots and handlers stay intact', async () => {
  const source = snapshot(), calls = [], original = { getSnapshot: async () => source, invokeItem: (...args) => { calls.push(args); } }, services = { applicationMenu: original };
  const menu = installRestartMenu(services, { restart: () => { calls.push('restart'); }, onError: error => assert.equal(error, null) }, nativeQuitItem);
  const extended = await services.applicationMenu.getSnapshot();
  assert.deepEqual(extended['file-menu'].map(x => x.label), ['New Window', 'Restart with CodexTopKits', 'Quit ChatGPT']);
  assert.equal(extended['edit-menu'], source['edit-menu']); assert.equal(source['file-menu'].length, 2);
  services.applicationMenu.invokeItem(5, 'native-argument');
  await services.applicationMenu.invokeItem(extended['file-menu'][1].nativeCommandId);
  assert.deepEqual(calls, [[5, 'native-argument'], 'restart']);
  menu.close(); assert.equal(services.applicationMenu, original);
});
test('repeat clicks coalesce and unexpected restart errors retain their cause', async () => {
  let reject, count = 0, observed;
  const original = { getSnapshot: async () => snapshot(), invokeItem() {} }, services = { applicationMenu: original };
  const menu = installRestartMenu(services, { restart: () => { count++; return new Promise((_, r) => { reject = r; }); }, onError: error => { observed = error; } }, nativeQuitItem);
  const id = (await menu.getSnapshot())['file-menu'][1].nativeCommandId;
  const work = services.applicationMenu.invokeItem(id); await Promise.resolve();
  assert.equal(services.applicationMenu.invokeItem(id), undefined); assert.equal(count, 1);
  const error = new SyntaxError('fixture original'); reject(error);
  await assert.rejects(work, value => value === error); assert.equal(observed, error); menu.close();
});
test('a changed quit contract is rejected without inventing a command', () => {
  for (const value of [null, { 'file-menu': [] }, { 'file-menu': [{ ...snapshot()['file-menu'][1], label: 'Something else' }] }]) assert.throws(() => nativeQuitItem(value), /has changed/);
});
test('Kit serialization includes its helpers and skips windows with no File menu', async () => {
  const source = featureModule(kit), packed = new Function(source.replace('export default ', 'return '))();
  const api = await packed.create({ serviceVersionChecks: true, document: { getElementById: () => null }, onDomChange: () => () => {} }, packed.helpers);
  api.close(); assert.equal(packed.manifest.minimumCoreVersion, '0.3.39');
});
test('serialized restart Kit resolves its label from the current language on each native snapshot', async () => {
  const packed = new Function(featureModule(kit).replace('export default ', 'return '))(), source = snapshot();
  const original = { getSnapshot: async () => source, invokeItem() {} }, services = { applicationMenu: original };
  let locale = 'en';
  const helpers = { ...packed.helpers, createNativeAssetReader: () => ({}), loadNativeAppServices: async () => services };
  const api = packed.create({ serviceVersionChecks: true, document: { getElementById: () => ({}) }, onDomChange: () => () => {}, dispatch() {}, reportError(error) { assert.equal(error, null); }, i18n: { t: (messages, key) => messages[locale][key] } }, helpers);
  await new Promise(setImmediate);
  assert.equal((await services.applicationMenu.getSnapshot())['file-menu'][1].label, 'Restart with CodexTopKits');
  locale = 'zh-Hans'; assert.equal((await services.applicationMenu.getSnapshot())['file-menu'][1].label, '使用 CodexTopKits 重启');
  api.close(); assert.equal(services.applicationMenu, original);
});
test('restart hands fixed absolute paths to its independent helper', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-restart-')), configPath = path.join(root, 'toolkit.json');
  await fs.writeFile(configPath, JSON.stringify({ stateDirectory: root }), 'utf8');
  const receipt = await startAppRestart({ configPath, powershellPath: 'C:/Runtime/pwsh.exe' }, { request: async () => ({ phase: 'running', languagePreference: { mode: 'auto' }, hostLanguage: 'en-US', systemLanguage: 'zh-CN' }), execute: async (exe, args, options) => {
    assert.equal(exe, 'C:/Runtime/pwsh.exe'); assert.equal(options.windowsHide, true);
    const data = JSON.parse(await fs.readFile(args.at(-1), 'utf8'));
    assert.equal(data.configPath, configPath); assert.equal(data.version, 1); assert.equal(data.nodeExecutable, process.execPath);
    assert.equal(data.resolvedLocale, 'en');
  } });
  assert.equal(receipt.accepted, true);
  await assert.rejects(startAppRestart({ configPath: 'relative', powershellPath: 'pwsh' }), /absolute/);
});
test('PowerShell waits until the actual process inventory becomes empty', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('../src/application-process.ps1', import.meta.url));
  const command = `. '${script.replaceAll("'", "''")}'; $script:observed=0; function Get-CodexApplicationProcess { $script:observed++; if($script:observed -lt 3){[pscustomobject]@{ProcessId=1}} }; function Start-Sleep {}; if(-not (Wait-CodexApplicationExit)){throw 'wait failed'}; if($script:observed -ne 3){throw 'stopped too soon'}; 'WAIT_PASSED'`;
  assert.match(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }), /WAIT_PASSED/);
});
test('the real one-time desktop task cancels before quit and removes its registration', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-restart-cancel-')), configPath = path.join(root, 'toolkit.json');
  const powershellPath = 'C:/Program Files/PowerShell/7/pwsh.exe';
  await fs.writeFile(configPath, JSON.stringify({ stateDirectory: root, powershellPath, plugins: [] }), 'utf8');
  const receipt = await startAppRestart({ configPath, powershellPath }, { execute: async (exe, args, options) => {
    await fs.writeFile(path.join(path.dirname(args.at(-1)), 'cancel'), 'cancel', 'utf8');
    return promisify(execFile)(exe, args, options);
  } });
  const deadline = Date.now() + 10000;
  while (!(await fs.readdir(receipt.directory)).includes('cancelled.json')) { if (Date.now() > deadline) throw new Error('The cancellation receipt did not arrive.'); await delay(100); }
  assert.equal((await fs.readdir(receipt.directory)).includes('quit-requested.json'), false);
  const result = JSON.parse(await fs.readFile(path.join(receipt.directory, 'ready.json'), 'utf8'));
  assert.equal(result.stage, 'ready');
  assert.match(result.taskName, /^CodexTopKits-Restart-[a-f0-9]{32}$/);
  const command = `$s=New-Object -ComObject Schedule.Service; $s.Connect(); @($s.GetFolder('\').GetTasks(1) | Where-Object Name -EQ '${result.taskName}').Count`;
  while (Number(execFileSync(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim()) !== 0) {
    if (Date.now() > deadline) throw new Error('The one-time restart task was not removed.'); await delay(100);
  }
});

// Keep worker tests with the desktop-task test: they share the real restart mutex.
async function workerFixture(decision) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-restart-decision-'));
  const configPath = path.join(root, 'toolkit.json'), requestPath = path.join(root, 'request.json');
  await fs.copyFile(fileURLToPath(new URL('../src/restart-worker.ps1', import.meta.url)), path.join(root, 'restart-worker.ps1'));
  await fs.copyFile(fileURLToPath(new URL('../src/localization.ps1', import.meta.url)), path.join(root, 'localization.ps1'));
  const files = {
    'toolkit.json': JSON.stringify({ stateDirectory: root }),
    'request.json': JSON.stringify({ configPath, nodeExecutable: process.execPath }),
    'go': 'go',
    'application-process.ps1': `function Get-CodexApplicationProcess { [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'calls.log'), "inventory\n", [Text.UTF8Encoding]::new($false)); [pscustomobject]@{ProcessId=123;ParentProcessId=1;CreationDate='fixture';ExecutablePath='fixture'} }
function Wait-CodexApplicationExit { param($TimeoutSeconds,$Processes); return $true }`,
    'apply-deployment.ps1': `param($ConfigPath,$NodePath,[switch]$Preflight)
[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'calls.log'), "preflight\n", [Text.UTF8Encoding]::new($false)); $global:LASTEXITCODE=0`,
    'restart-confirmation.ps1': `function Confirm-CodexRestart { param([scriptblock]$OnShown,[scriptblock]$IsCancelled,[string]$Locale)
[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'calls.log'), "confirmation\n", [Text.UTF8Encoding]::new($false))
$null = & $OnShown; [pscustomobject]@{decision='${decision}';elapsedMs=20} }`,
    'cli.mjs': `import fs from 'node:fs'; import path from 'node:path';
const action=process.argv[2]; fs.appendFileSync(path.join(import.meta.dirname,'calls.log'),action+'\\n','utf8');
if(action==='quit-native')console.log(JSON.stringify({quitRequested:true}));
else if(action==='status')console.log(JSON.stringify({phase:'running',instanceId:'fixture-instance',cdp:{connected:true}}));
else throw new Error('Unexpected fixture action: '+action);`,
    'start-toolkit.ps1': `param($ConfigPath,$NodePath,$PreviousLaunchId)
[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'calls.log'), "start\n", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'last-launch.json'), '{"id":"fixture-launch","stage":"completed","result":{"instanceId":"fixture-instance"}}', [Text.UTF8Encoding]::new($false)); $global:LASTEXITCODE=0`,
    'run.ps1': `param($RequestPath)
$ErrorActionPreference='Stop'; $global:fixtureRoot=$PSScriptRoot
function New-Object { param($ComObject)
  if($ComObject -ne 'Schedule.Service'){throw 'Unexpected COM access in fixture'}
  $scheduler=[pscustomobject]@{}
  $scheduler | Add-Member ScriptMethod Connect {}
  $scheduler | Add-Member ScriptMethod GetFolder { param($name)
    $folder=[pscustomobject]@{}
    $folder | Add-Member ScriptMethod DeleteTask { param($name,$flags)
      [IO.File]::WriteAllText((Join-Path $global:fixtureRoot 'task-deleted'),$name,[Text.UTF8Encoding]::new($false))
    }; return $folder
  }; return $scheduler
}
& (Join-Path $PSScriptRoot 'restart-worker.ps1') -RequestPath $RequestPath -TaskName 'CodexTopKits-Restart-0123456789abcdef0123456789abcdef'`,
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content, 'utf8');
  await promisify(execFile)('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'run.ps1'), '-RequestPath', requestPath], { encoding: 'utf8', windowsHide: true });
  return { root, calls: (await fs.readFile(path.join(root, 'calls.log'), 'utf8')).trim().split('\n'), files: await fs.readdir(root) };
}

test('cancelled confirmation ends the real worker before inventory, quit or launch', { skip: process.platform !== 'win32' }, async () => {
  const result = await workerFixture('cancelled');
  assert.deepEqual(result.calls, ['preflight', 'confirmation']);
  assert.ok(result.files.includes('cancelled.json'));
  assert.ok(result.files.includes('task-deleted'));
  assert.ok(!result.files.includes('before-quit.json'));
  assert.ok(!result.files.includes('application-exited.json'));
});

for (const decision of ['restart-now', 'timeout']) test(`${decision} proceeds once through the existing worker lifecycle`, { skip: process.platform !== 'win32' }, async () => {
  const result = await workerFixture(decision);
  assert.deepEqual(result.calls, ['preflight', 'confirmation', 'inventory', 'quit-native', 'start', 'status']);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.root, 'decision.json'), 'utf8')).decision, decision);
  assert.ok(result.files.includes('completed.json'));
  assert.ok(result.files.includes('task-deleted'));
});
