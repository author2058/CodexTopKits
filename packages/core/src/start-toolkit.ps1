#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)][string]$NodePath, [string]$PreviousLaunchId)
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
. (Join-Path $PSScriptRoot 'application-process.ps1')
. (Join-Path $PSScriptRoot 'launch-lock.ps1')
. (Join-Path $PSScriptRoot 'localization.ps1')
$cli = Join-Path ([IO.Path]::GetDirectoryName($ConfigPath)) 'node_modules/codex-toolkit-core/src/cli.mjs'
function Invoke-Toolkit([string]$Action) {
    $arguments = @($cli, $Action, $ConfigPath)
    if ($Action -eq 'launch' -and $PreviousLaunchId) { $arguments += '--one-time-restart' }
    $output = & $NodePath @arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw (((Get-CodexText 'Toolkit {0} failed (exit {1}).' 'Toolkit {0} 失败（退出代码 {1}）。') -f $Action, $LASTEXITCODE) + "`n" + ($output | Out-String).TrimEnd()) }
    $output | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }
    ($output | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | Out-String) | ConvertFrom-Json -AsHashtable
}
$settings = [IO.File]::ReadAllText($ConfigPath, $utf8) | ConvertFrom-Json -AsHashtable
$stateDirectory = [IO.Path]::GetFullPath($settings.stateDirectory, [IO.Path]::GetDirectoryName($ConfigPath))
$CodexLocale = Get-CodexLocale -StateDirectory $stateDirectory
[void][IO.Directory]::CreateDirectory($stateDirectory)
$key = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes([IO.Path]::GetFullPath($ConfigPath).ToLowerInvariant())))
$null = Invoke-SerializedCodexLaunch -Key $key -ReceiptPath (Join-Path $stateDirectory 'last-launch.json') -PreviousLaunchId $PreviousLaunchId -Launch {
    # Decide deployment only after exit; a quick shortcut click must not skip it.
    if ($PreviousLaunchId) { Assert-CodexApplicationExited -Message (Get-CodexText 'Another Codex instance opened while restarting. Its work was left running.' '重启期间另一个 Codex 实例已打开，仍保持运行。') }
    else { $null = Wait-CodexApplicationExit }
    $null = & (Join-Path $PSScriptRoot 'apply-deployment.ps1') -ConfigPath $ConfigPath -NodePath $NodePath
    $runtime = Invoke-Toolkit 'status'
    if ($runtime.phase -eq 'stopped') { Write-Host (Get-CodexText 'Starting CodexTopKits…' '正在启动 CodexTopKits…'); $null = Invoke-Toolkit 'start' }
    Write-Host (Get-CodexText 'Opening Codex…' '正在打开 Codex…')
    $opened = Invoke-Toolkit 'launch'
    $runtime = Invoke-Toolkit 'status'
    return @{ instanceId = $runtime.instanceId; pid = $opened.pid }
} -Verify {
    param($Result)
    $actual = Invoke-Toolkit 'status'
    if ($actual.phase -ne 'running' -or -not $Result.instanceId -or $actual.instanceId -cne $Result.instanceId -or ($actual.cdp -and -not $actual.cdp.connected) -or -not @(Get-CodexApplicationProcess).Count) { throw (Get-CodexText 'The launch did not produce a running Codex with the expected Toolkit instance.' '启动后未检测到预期的 Codex 和 Toolkit 实例。') }
}
Write-Host (Get-CodexText 'Codex is ready.' 'Codex 已就绪。')
