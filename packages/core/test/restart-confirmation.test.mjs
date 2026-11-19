import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile), powershell = 'C:/Program Files/PowerShell/7/pwsh.exe';
const confirmation = fileURLToPath(new URL('../src/restart-confirmation.ps1', import.meta.url));
const nativeFixture = fileURLToPath(new URL('./restart-confirmation.fixture.ps1', import.meta.url));

test('native confirmation actions and full 20-second countdown', { skip: process.platform !== 'win32' }, async t => {
  for (const scenario of ['restart-now', 'cancel', 'close', 'external-cancel', 'error', 'timer-error', 'timeout']) await t.test(scenario, async () => {
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-File', nativeFixture, '-ConfirmationPath', confirmation, '-Scenario', scenario], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    const result = JSON.parse(stdout);
    if (scenario.endsWith('error')) { assert.match(result.error, /fixture-dialog-failure/); return; }
    assert.equal(result.decision, scenario === 'timeout' ? 'timeout' : scenario === 'restart-now' ? 'restart-now' : 'cancelled');
    assert.equal(result.shown, true);
    assert.equal(result.heading, 'Codex 将在 20 秒后重启');
    assert.equal(result.restartLabel, '立即重启');
    assert.equal(result.cancelLabel, '取消');
    if (scenario === 'timeout') assert.ok(result.elapsedMs >= 20000, 'The user must receive the complete countdown.');
    else assert.ok(result.elapsedMs < 20000, 'An explicit decision must skip the remaining wait.');
  });
});
