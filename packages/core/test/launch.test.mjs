import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runLaunchHelper, launchToolkit } from '../src/launch.mjs';

test('launch reconnects an existing disconnected runtime once after opening the app', async () => {
  const calls = [], health = { ok: true }, result = { launched: true, pid: 123 };
  const actual = await launchToolkit({ powershellPath: 'pwsh', stateDirectory: 'fixture' }, {
    request: async (directory, action) => {
      assert.equal(directory, 'fixture'); calls.push(action);
      return action === 'environment' ? { cdp: { connected: false }, environment: { FIXTURE: 'child-only' } } : { health };
    },
    launch: async options => { calls.push('launch'); assert.equal(options.environment.FIXTURE, 'child-only'); return result; },
  });
  assert.deepEqual(calls, ['environment', 'launch', 'reconnect']);
  assert.deepEqual(actual, { ...result, health });
});

test('connected and non-CDP runtimes retain the existing launch result without another check', async () => {
  for (const cdp of [{ connected: true }, null]) {
    const result = { launched: true }, actions = [];
    assert.equal(await launchToolkit({ stateDirectory: 'fixture' }, {
      request: async (_, action) => { actions.push(action); return { cdp, environment: {} }; },
      launch: async () => result,
    }), result);
    assert.deepEqual(actions, ['environment']);
  }
});

test('post-launch health gaps remain visible and unexpected failures escape unchanged without retry', async () => {
  const health = { ok: false, plugins: [{ ok: false, message: 'fixture gap' }] };
  const services = { request: async (_, action) => action === 'environment' ? { cdp: { connected: false }, environment: {} } : { health }, launch: async () => ({ launched: true }) };
  assert.equal((await launchToolkit({ stateDirectory: 'fixture' }, services)).health, health);
  const original = new SyntaxError('fixture invalid response'); let checks = 0;
  services.request = async (_, action) => { if (action === 'environment') return { cdp: { connected: false }, environment: {} }; checks++; throw original; };
  await assert.rejects(launchToolkit({ stateDirectory: 'fixture' }, services), error => error === original);
  assert.equal(checks, 1);
  services.launch = async () => { throw original; }; checks = 0;
  await assert.rejects(launchToolkit({ stateDirectory: 'fixture' }, services), error => error === original);
  assert.equal(checks, 0);
});

async function fixture(script) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-launch-'));
  const scriptPath = path.join(root, 'helper.ps1');
  await fs.writeFile(scriptPath, script, 'utf8');
  return { root, scriptPath };
}

test('the launcher returns while its synthetic app remains alive with inherited standard handles', async t => {
  const { root, scriptPath } = await fixture(`param([string]$ResultPath,[string]$StateDirectory)
$ErrorActionPreference = 'Stop'
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = '${process.execPath.replaceAll("'", "''")}'
$start.UseShellExecute = $false
$start.ArgumentList.Add('-e')
$start.ArgumentList.Add('setTimeout(() => {}, 5000)')
$child = [Diagnostics.Process]::Start($start)
[IO.File]::WriteAllText($ResultPath, (@{ pid = $child.Id; launched = $true; fixture = $env:TOOLKIT_LAUNCH_FIXTURE } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
`);
  const result = await runLaunchHelper({ powershellPath: 'pwsh', scriptPath, stateDirectory: root,
    environment: { ...process.env, TOOLKIT_LAUNCH_FIXTURE: 'child-only' } });
  t.after(() => { try { process.kill(result.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  assert.equal(result.launched, true);
  assert.equal(result.fixture, 'child-only');
  assert.equal(process.env.TOOLKIT_LAUNCH_FIXTURE, undefined);
  assert.doesNotThrow(() => process.kill(result.pid, 0));
});

test('the real launch helper declares the same PowerShell 7 requirement as the entries', async () => {
  const source = await fs.readFile(new URL('../src/launch-codex.ps1', import.meta.url), 'utf8');
  assert.match(source, /^#Requires -Version 7\.0\r?\n/);
});

test('one-time restart policy reaches the final PowerShell activation helper', async () => {
  const { root, scriptPath } = await fixture(`param([string]$ResultPath,[string]$StateDirectory,[switch]$OneTimeRestart)\n[IO.File]::WriteAllText($ResultPath,(@{oneTime=$OneTimeRestart.IsPresent}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))\n`);
  const result = await launchToolkit({ stateDirectory: root, powershellPath: 'pwsh', oneTimeRestart: true }, {
    request: async () => ({ cdp: null, environment: {} }),
    launch: options => runLaunchHelper({ ...options, scriptPath }),
  });
  assert.equal(result.oneTime, true);
});

test('a helper failure preserves its original stderr and exit code', async () => {
  const { root, scriptPath } = await fixture("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\nthrow 'fixture 启动失败'\n");
  let stderrPath;
  await assert.rejects(runLaunchHelper({ powershellPath: 'pwsh', scriptPath, stateDirectory: root, environment: process.env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.message, /fixture 启动失败/);
    stderrPath = error.stderrPath;
    return true;
  });
  assert.match(await fs.readFile(stderrPath, 'utf8'), /fixture 启动失败/);
});
