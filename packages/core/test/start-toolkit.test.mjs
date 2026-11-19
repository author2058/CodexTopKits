import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareEntries } from '../src/prepare-entry.mjs';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const pwsh = 'C:/Program Files/PowerShell/7/pwsh.exe';

test('noninteractive restart preserves actual Node diagnostics from deployment and startup', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-start-error-'));
  const src = path.join(root, 'src'), config = path.join(root, 'toolkit.json');
  await fs.mkdir(src);
  for (const name of ['start-toolkit.ps1', 'apply-deployment.ps1', 'localization.ps1']) await fs.copyFile(path.join(source, name), path.join(src, name));
  await fs.writeFile(path.join(src, 'application-process.ps1'), 'function Assert-CodexApplicationExited {}\n', 'utf8');
  await fs.writeFile(path.join(src, 'launch-lock.ps1'), 'function Invoke-SerializedCodexLaunch { param($Key,$ReceiptPath,$Launch,$Verify,$PreviousLaunchId); & $Launch }\n', 'utf8');
  const fixture = `import fs from 'node:fs';\nconst action = process.argv[2], config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));\nif (action === config.failAction) { console.error('fixture Node diagnostic: Duplicate installed feature ID.'); process.exit(9); }\nif (action === 'status') { console.error('fixture warning'); console.log(JSON.stringify({ phase: 'stopped' })); }\nelse console.log(JSON.stringify({ ok: true }));\n`;
  await fs.writeFile(path.join(src, 'cli.mjs'), fixture, 'utf8');
  const installed = path.join(root, 'node_modules', 'codex-toolkit-core', 'src');
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(installed, 'cli.mjs'), fixture, 'utf8');
  for (const failAction of ['deployment-apply', 'start']) {
    await fs.writeFile(config, JSON.stringify({ stateDirectory: root, failAction }), 'utf8');
    const command = `try { & ${quote(path.join(src, 'start-toolkit.ps1'))} -ConfigPath ${quote(config)} -NodePath ${quote(process.execPath)} -PreviousLaunchId 'fixture' *> ${quote(path.join(root, 'launch.log'))} } catch { [Console]::Error.WriteLine('ORIGINAL: ' + $_.Exception.Message); exit 17 }`;
    const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 17, result.stdout + result.stderr);
    assert.match(result.stderr, /ORIGINAL: [\s\S]*fixture Node diagnostic: Duplicate installed feature ID\./);
    assert.doesNotMatch(result.stderr, /Read-Host|NonInteractive|non-interactive/i);
    if (failAction === 'start') assert.match(result.stderr, /fixture warning/);
  }
  assert.doesNotMatch(await fs.readFile(path.join(source, 'start-toolkit.ps1'), 'utf8'), /Read-Host/);
});

test('manual entries request the localized pause; wrapper defaults to no pause', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-manual-entry-'));
  const config = path.join(root, 'toolkit.json'), fake = path.join(root, 'failure.ps1');
  await fs.writeFile(config, JSON.stringify({ stateDirectory: root }), 'utf8');
  await fs.writeFile(fake, "param($ConfigPath,$NodePath)\nthrow 'fixture startup failure'\n", 'utf8');
  await prepareEntries({ configPath: config, powershellPath: pwsh });
  const wrapperPath = path.join(root, 'start-toolkit.ps1');
  const wrapper = await fs.readFile(wrapperPath, 'utf8');
  assert.match(await fs.readFile(path.join(root, 'launch-main.ps1'), 'utf8'), /start-toolkit\.ps1'\) -PauseOnFailure/);
  assert.match(await fs.readFile(path.join(root, 'start-toolkit.cmd'), 'utf8'), /start-toolkit\.ps1" -PauseOnFailure/);
  await fs.writeFile(wrapperPath, wrapper.replace(quote(path.join(source, 'start-toolkit.ps1')), quote(fake)), 'utf8');
  for (const locale of ['en', 'zh-Hans']) {
    await fs.writeFile(path.join(root, 'language.json'), JSON.stringify({ mode: 'fixed', locale }), 'utf8');
    for (const manual of [false, true]) {
      const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true); function Read-Host { param($Prompt); Write-Host ('PROMPT: ' + $Prompt) }; & ${quote(wrapperPath)}${manual ? ' -PauseOnFailure' : ''}`;
      const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /fixture startup failure/);
      if (manual) assert.ok(result.stdout.includes(locale === 'en' ? 'PROMPT: Press Enter to close' : 'PROMPT: 按 Enter 关闭'));
      else assert.doesNotMatch(result.stdout, /PROMPT:/);
    }
  }
});
