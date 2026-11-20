import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeQuitItem, installRestartMenu } from '../src/application-menu.mjs';
import { quitNativeApplication } from '../src/quit-native.mjs';
import { readDeployment } from '../src/deployment.mjs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

test('an incompatible quit snapshot preserves the native menu and later clears its warning', async () => {
  let source = { 'file-menu': [{ type: 'item', nativeCommandId: 7, label: 'Quit ChatGPT', enabled: true }] }, reported;
  const services = { applicationMenu: { getSnapshot: async () => source, invokeItem() {} } };
  const menu = installRestartMenu(services, { restart() {}, onError: error => { reported = error; } }, nativeQuitItem);
  await menu.getSnapshot(); source = { 'file-menu': [{ type: 'item', nativeCommandId: 7, label: 'Quit ChatGPT', enabled: false }] };
  assert.equal(await menu.getSnapshot(), source); assert.equal(reported.code, 'CODEX_QUIT_MENU_CHANGED');
  source['file-menu'][0].enabled = true; assert.equal((await menu.getSnapshot())['file-menu'].length, 2); assert.equal(reported, null); menu.close();
});
test('native quit errors are received before success; a closed renderer remains explicitly unconfirmed', async () => {
  for (const mode of ['success', 'error', 'close']) {
    class Socket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() { this.dispatchEvent(new Event('close')); }
      send(json) {
        assert.match(JSON.parse(json).params.expression, /await services\.applicationMenu\.invokeItem/);
        queueMicrotask(() => {
          if (mode === 'close') return this.close();
          const result = mode === 'error' ? { exceptionDetails: { exception: { description: 'Native quit original error' } } } : { result: { value: { quitRequested: true } } };
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result }) }));
        });
      }
    }
    const deps = { Socket, request: async () => ({ cdp: { connected: true, port: 13333 } }), fetchImpl: async () => ({ ok: true, json: async () => [{ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:13333/devtools/page/test' }] }) };
    if (mode === 'error') await assert.rejects(quitNativeApplication('fixture', deps), /Native quit original error/);
    else assert.equal((await quitNativeApplication('fixture', deps)).quitRequested, mode === 'success');
  }
});

test('the real WebSocket error-before-close shutdown remains unconfirmed for process-exit verification', async t => {
  const server = createServer(), sockets = new WebSocketServer({ server });
  t.after(async () => { await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  sockets.on('connection', socket => socket.once('message', () => socket.terminate()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const result = await quitNativeApplication('fixture', {
    request: async () => ({ cdp: { connected: true, port } }),
    fetchImpl: async () => ({ ok: true, json: async () => [{ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/fixture` }] }),
  });
  assert.equal(result.quitRequested, false);
  assert.equal(result.connectionClosedBeforeAcknowledgement, true);
  assert.equal(result.connectionError.name, 'TypeError');
  assert.match(result.connectionError.stack, /onSocketClose/);
});

test('native quit accepts chat route queries and fragments while excluding other surfaces', async () => {
  const excluded = [
    { type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay' },
    { type: 'page', url: 'app://-/detached-window.html?initialRoute=%2Fdetached-window' },
    { type: 'page', url: 'https://example.test/index.html' },
    { type: 'iframe', url: 'app://-/index.html' },
  ];
  class Socket extends EventTarget {
    constructor(url) { super(); assert.equal(url.href, 'ws://127.0.0.1:13333/devtools/page/chat'); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    close() {}
    send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result: { result: { value: { quitRequested: true } } } }) }))); }
  }
  const deps = { Socket, request: async () => ({ cdp: { connected: true, port: 13333 } }) };
  for (const suffix of ['', '?initialRoute=%2Flocal%2Ffixture', '#chat', '?initialRoute=%2Flocal%2Ffixture#chat']) {
    const fetchImpl = async () => ({ ok: true, json: async () => [...excluded, { type: 'page', url: 'app://-/index.html' + suffix, webSocketDebuggerUrl: 'ws://127.0.0.1:13333/devtools/page/chat' }] });
    assert.equal((await quitNativeApplication('fixture', { ...deps, fetchImpl })).quitRequested, true);
  }
  await assert.rejects(quitNativeApplication('fixture', { ...deps, fetchImpl: async () => ({ ok: true, json: async () => excluded }) }), /No Codex chat window/);
});

test('a debug transport failure before dispatch retains its original error', async () => {
  const original = new TypeError('fixture connection failed');
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('error'), { error: original }))); }
    close() {}
  }
  await assert.rejects(quitNativeApplication('fixture', {
    Socket, request: async () => ({ cdp: { connected: true, port: 13333 } }),
    fetchImpl: async () => ({ ok: true, json: async () => [{ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:13333/devtools/page/fixture' }] }),
  }), error => error === original);
});
test('edited settings invalidate a prepared full configuration before shutdown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-config-conflict-')), configPath = path.join(root, 'toolkit.json'), next = path.join(root, 'next.json');
  const hash = text => createHash('sha256').update(text).digest('hex');
  await fs.writeFile(configPath, '{}', 'utf8'); await fs.writeFile(next, '{"next":true}', 'utf8');
  const head = 'c'.repeat(40), manifest = { version: 1, sourceRevision: head, review: { outcome: 'PASS', head }, artifacts: [], kitUpdates: [], config: { path: next, sha256: hash('{"next":true}'), originalSha256: hash('{}') } };
  await fs.writeFile(path.join(root, 'pending-deployment.json'), JSON.stringify(manifest), 'utf8');
  assert.ok(await readDeployment(configPath)); await fs.writeFile(configPath, '{"userEdit":true}', 'utf8');
  await assert.rejects(readDeployment(configPath), /settings changed/); assert.equal(await fs.readFile(configPath, 'utf8'), '{"userEdit":true}');
});
test('a competing launcher waits for the owning result instead of reporting a second success', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-launch-race-')), receipt = path.join(root, 'receipt.json'), ready = path.join(root, 'ready'), go = path.join(root, 'go');
  const helper = fileURLToPath(new URL('../src/launch-lock.ps1', import.meta.url)), key = path.basename(root), run = promisify(execFile);
  const literal = text => "'" + text.replaceAll("'", "''") + "'";
  const script = path.join(root, 'race.ps1');
  await fs.writeFile(script, `param([switch]$Waiter,[string]$Previous)\n$ErrorActionPreference='Stop'\n. ${literal(helper)}\n$CodexLocale='en'\n$work={ if($Waiter){throw 'Second launcher must not execute'}; [IO.File]::WriteAllText(${literal(ready)},'ready',[Text.UTF8Encoding]::new($false)); while(-not(Test-Path -LiteralPath ${literal(go)})){Start-Sleep -Milliseconds 20}; @{instanceId='verified-instance'} }\n$result=Invoke-SerializedCodexLaunch -Key ${literal(key)} -ReceiptPath ${literal(receipt)} -PreviousLaunchId $Previous -Launch $work -Verify {param($r) if($r.instanceId -cne 'verified-instance'){throw 'Wrong instance'}}\n$result | ConvertTo-Json -Compress\n`, 'utf8');
  const owner = run('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', windowsHide: true });
  const deadline = Date.now() + 10000;
  while (!(await fs.readdir(root)).includes('ready')) { if (Date.now() >= deadline) throw new Error('Synthetic owner did not start'); await delay(20); }
  const waiter = run('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-Waiter'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  waiter.child.stdout.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    let output = '';
    const receive = chunk => { output += chunk; if (output.includes('Waiting for its result')) { waiter.child.stdout.off('data', receive); resolve(); } };
    waiter.child.stdout.on('data', receive); waiter.then(() => reject(new Error('Waiter exited before observing contention.')), reject);
  });
  await fs.writeFile(go, 'go', 'utf8');
  const results = await Promise.all([owner, waiter]);
  assert.ok(results.every(result => result.stdout.includes('verified-instance')));
  assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).stage, 'completed');
  const late = await run('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-Waiter', '-Previous', 'none'], { encoding: 'utf8', windowsHide: true });
  assert.match(late.stdout, /verified-instance/);
});

test('process exit waits for the old PID and birth time, not its replacement', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../src/application-process.ps1', import.meta.url));
  const command = `. '${helper.replaceAll("'", "''")}'; function Get-CodexApplicationProcess { [pscustomobject]@{ProcessId=9;CreationDate='new'} }; if(-not(Wait-CodexApplicationExit -TimeoutSeconds 1 -Processes @([pscustomobject]@{ProcessId=9;CreationDate='old'}))){throw 'Waited for a reused PID'}; 'IDENTITY_PASSED'`;
  assert.match(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }), /IDENTITY_PASSED/);
});

test('exit waits tolerate disappearing paths but activation still requires verified identity', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../src/application-process.ps1', import.meta.url));
  const command = `. '${helper.replaceAll("'", "''")}'; $CodexLocale='en'; $script:reads=0; function Get-CimInstance { $script:reads++; if($script:reads -lt 3){ [pscustomobject]@{ProcessId=9;SessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;CreationDate='old';ExecutablePath=$null} } }; function Start-Sleep {}; if(-not(Wait-CodexApplicationExit -Processes @([pscustomobject]@{ProcessId=9;CreationDate='old'}))){throw 'wait failed'}; if($script:reads -ne 3){throw 'Exited before the original PID disappeared'}; $script:reads=0; try{Assert-CodexApplicationExited;throw 'Unverified activation allowed'}catch{if($_.Exception.Message -ne 'Cannot verify ChatGPT process 9.'){throw}}; $script:reads=0; if(-not(Wait-CodexApplicationExit)){throw 'Quick shortcut wait failed'}; if($script:reads -ne 3){throw 'Quick shortcut did not await exit'}; 'EXIT_PATH_PASSED'`;
  assert.match(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }), /EXIT_PATH_PASSED/);
});

test('activation rechecks an unreadable snapshot without accepting a live unknown process', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../src/application-process.ps1', import.meta.url));
  const command = `
    . '${helper.replaceAll("'", "''")}'
    $CodexLocale='en'
    function Get-CimInstance {
      param($ClassName, $Filter)
      $row=[pscustomobject]@{ProcessId=4648;SessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;CreationDate='old';ExecutablePath=$null}
      if($Filter -eq "Name='ChatGPT.exe'"){return $row}
      if($Filter -ne 'ProcessId=4648'){throw 'Unexpected inventory request'}
      switch($script:scenario){
        'gone' { return }
        'reused' { $row.CreationDate='replacement'; return $row }
        'readable' { $row.ExecutablePath='C:/Program Files/WindowsApps/OpenAI.Codex_fixture/app/ChatGPT.exe'; return $row }
        'unknown' { return $row }
      }
    }
    foreach($script:scenario in @('gone','reused')){if(@(Get-CodexApplicationProcess).Count){throw 'Stale process was retained'}}
    $script:scenario='readable'
    if(@(Get-CodexApplicationProcess).Count -ne 1){throw 'Verified process was lost'}
    $script:scenario='unknown'
    try{Get-CodexApplicationProcess;throw 'Live unknown process accepted'}catch{if($_.Exception.Message -cne 'Cannot verify ChatGPT process 4648.'){throw}}
    'SNAPSHOT_RECHECK_PASSED'
  `;
  assert.match(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }), /SNAPSHOT_RECHECK_PASSED/);
});

test('a temporarily unreadable birth time keeps the old PID pending', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../src/application-process.ps1', import.meta.url));
  const command = `. '${helper.replaceAll("'", "''")}'; $script:reads=0; function Get-CodexApplicationProcess { $script:reads++; if($script:reads -lt 3){ [pscustomobject]@{ProcessId=9;CreationDate=$null;ExecutablePath=$null} } }; function Start-Sleep {}; if(-not(Wait-CodexApplicationExit -Processes @([pscustomobject]@{ProcessId=9;CreationDate='old'}))){throw 'wait failed'}; if($script:reads -ne 3){throw 'Missing metadata was mistaken for exit'}; 'BIRTH_PENDING_PASSED'`;
  assert.match(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }), /BIRTH_PENDING_PASSED/);
});

test('a quick shortcut cannot infer exit from an initially unknown birth time', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../src/application-process.ps1', import.meta.url));
  const command = `. '${helper.replaceAll("'", "''")}'; $script:reads=0; function Get-CodexApplicationProcess { $script:reads++; if($script:reads -lt 3){[pscustomobject]@{ProcessId=9;CreationDate=$(if($script:reads -eq 1){$null}else{'old'})}} }; function Start-Sleep {}; if(-not(Wait-CodexApplicationExit)){throw 'Wait failed'}; if($script:reads -ne 3){throw 'Unknown birth time was interpreted as exit'}; 'UNKNOWN_INITIAL_BIRTH_PASSED'`;
  assert.match(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }), /UNKNOWN_INITIAL_BIRTH_PASSED/);
});

test('ordinary activation rejects a new unreadable-path PID after the original exits', { skip: process.platform !== 'win32' }, async () => {
  const helper = fileURLToPath(new URL('../src/launch-codex.ps1', import.meta.url));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctk-unreadable-replacement-'));
  const activations = path.join(root, 'activations.txt'), result = path.join(root, 'result.json');
  const literal = text => "'" + text.replaceAll("'", "''") + "'";
  const recordActivation = `require('node:fs').appendFileSync(${JSON.stringify(activations)}, 'activated\\n', 'utf8')`;
  const command = `
    . ${literal(helper)}
    $CodexLocale = 'en'
    $script:reads = 0
    function Get-CimInstance {
      $script:reads++
      $currentId = if ($script:reads -eq 1) { 9 } else { 10 }
      [pscustomobject]@{ ProcessId=$currentId; SessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId; CreationDate='fixture'; ExecutablePath=$null }
    }
    function New-CodexToolkitStartInfo {
      $info = [Diagnostics.ProcessStartInfo]::new(${literal(process.execPath)})
      $info.UseShellExecute = $false
      $info.ArgumentList.Add('-e')
      $info.ArgumentList.Add(${literal(recordActivation)})
      return $info
    }
    try { Invoke-CodexApplicationLaunch -ResultPath ${literal(result)}; throw 'Expected unreadable replacement rejection' }
    catch { if ($_.Exception.Message -cne 'Cannot verify ChatGPT process 10.') { throw } }
    if ($script:reads -ne 4) { throw 'Activation did not recheck the replacement identity after exit waiting' }
    'ORDINARY_REPLACEMENT_REJECTED'
  `;
  assert.match(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }), /ORDINARY_REPLACEMENT_REJECTED/);
  await assert.rejects(fs.access(activations), { code: 'ENOENT' });
  await assert.rejects(fs.access(result), { code: 'ENOENT' });
});

test('a one-time restart rejects a new independent instance without waiting for its future exit', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../src/application-process.ps1', import.meta.url));
  const command = `. '${helper.replaceAll("'", "''")}'; function Get-CodexApplicationProcess { [pscustomobject]@{ProcessId=99;CreationDate='new'} }; try { Assert-CodexApplicationExited -Message 'Independent instance preserved'; throw 'did not reject' } catch { if($_.Exception.Message -ne 'Independent instance preserved'){throw}; 'REJECTED_WITHOUT_WAIT' }`;
  assert.match(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }), /REJECTED_WITHOUT_WAIT/);
});

test('a native command-ID collision keeps native dispatch and disables the injected action', async () => {
  let source = { 'file-menu': [{ type: 'item', nativeCommandId: 7, label: 'Quit ChatGPT', enabled: true }] }, reported, native;
  const services = { applicationMenu: { getSnapshot: async () => source, invokeItem: id => { native = id; } } };
  const menu = installRestartMenu(services, { restart() { throw new Error('Must not restart on collision'); }, onError: error => { reported = error; } }, nativeQuitItem);
  const id = (await menu.getSnapshot())['file-menu'][0].nativeCommandId;
  source = { 'file-menu': [{ type: 'item', nativeCommandId: id, label: 'Native action', enabled: true }, ...source['file-menu']] };
  assert.equal(await menu.getSnapshot(), source); assert.equal(reported.code, 'CODEX_RESTART_COMMAND_COLLISION');
  services.applicationMenu.invokeItem(id); assert.equal(native, id); menu.close();
});

test('final one-time activation does not wait for an instance opened during installation', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../src/launch-codex.ps1', import.meta.url));
  const command = `. '${helper.replaceAll("'", "''")}'; $CodexLocale='en'; function Get-CodexApplicationProcess { [pscustomobject]@{ProcessId=9;CreationDate='new'} }; function Wait-CodexApplicationExit { throw 'Must not wait for an independent instance' }; function New-CodexToolkitStartInfo { [Diagnostics.ProcessStartInfo]::new('must-not-run') }; try { Invoke-CodexApplicationLaunch -ResultPath 'unused-result.json' -OneTimeRestart; throw 'Expected an instance conflict' } catch { if($_.Exception.Message -notlike '*Another Codex instance opened*'){throw}; 'FINAL_ACTIVATION_REJECTED' }`;
  assert.match(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }), /FINAL_ACTIVATION_REJECTED/);
});
