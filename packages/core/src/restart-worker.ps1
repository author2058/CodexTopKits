#Requires -Version 7.0
param([Parameter(Mandatory)][string]$RequestPath, [Parameter(Mandatory)][string]$TaskName)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'localization.ps1')
if ($TaskName -notmatch '^CodexTopKits-Restart-[a-f0-9]{32}$') { throw (Get-CodexText 'Invalid one-time restart task identity.' '一次性重启任务标识无效。') }
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$directory = [IO.Path]::GetDirectoryName($RequestPath)
$request = [IO.File]::ReadAllText($RequestPath, $utf8) | ConvertFrom-Json -AsHashtable
$configuration = [IO.File]::ReadAllText($request.configPath, $utf8) | ConvertFrom-Json -AsHashtable
$stateDirectory = [IO.Path]::GetFullPath($configuration.stateDirectory, [IO.Path]::GetDirectoryName($request.configPath))
$CodexLocale = Get-CodexLocale -StateDirectory $stateDirectory -ResolvedLocale $request.resolvedLocale
. (Join-Path $PSScriptRoot 'application-process.ps1')
. (Join-Path $PSScriptRoot 'restart-confirmation.ps1')
function Receipt([string]$Stage, [hashtable]$Details = @{}) {
    $value = @{ stage = $Stage; at = [DateTimeOffset]::Now.ToString('o') } + $Details
    [IO.File]::WriteAllText((Join-Path $directory ($Stage + '.json')), ($value | ConvertTo-Json -Depth 10), $utf8)
}
$mutex = [Threading.Mutex]::new($false, 'Local\CodexTopKits-Restart')
$locked = $false
try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { throw (Get-CodexText 'Another Codex restart is already in progress.' '另一个 Codex 重启操作正在进行。') }
    & (Join-Path $PSScriptRoot 'apply-deployment.ps1') -ConfigPath $request.configPath -NodePath $request.nodeExecutable -Preflight
    Receipt 'ready' @{ taskName = $TaskName }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath (Join-Path $directory 'go'))) {
        if ((Test-Path -LiteralPath (Join-Path $directory 'cancel')) -or $watch.Elapsed.TotalSeconds -ge 70) { Receipt 'cancelled'; return }
        Start-Sleep -Milliseconds 100
    }
    if (Test-Path -LiteralPath (Join-Path $directory 'cancel')) { Receipt 'cancelled'; return }
    $decision = Confirm-CodexRestart -Locale $CodexLocale -OnShown { Receipt 'countdown' @{ seconds = 20 } } -IsCancelled { Test-Path -LiteralPath (Join-Path $directory 'cancel') }
    Receipt 'decision' @{ decision = $decision.decision; elapsedMs = $decision.elapsedMs }
    if ($decision.decision -eq 'cancelled') { Receipt 'cancelled' @{ reason = 'Restart cancelled.' }; return }
    $oldProcesses = @(Get-CodexApplicationProcess)
    $previousLaunchId = 'none'
    if (Test-Path -LiteralPath (Join-Path $stateDirectory 'last-launch.json')) { $previousLaunchId = ([IO.File]::ReadAllText((Join-Path $stateDirectory 'last-launch.json'), $utf8) | ConvertFrom-Json -AsHashtable).id }
    if (-not $previousLaunchId) { throw (Get-CodexText 'The previous launch receipt has no operation ID.' '上次启动记录缺少操作 ID。') }
    Receipt 'before-quit' @{ processes = @($oldProcesses | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath) }
    $quitOutput = & $request.nodeExecutable (Join-Path $PSScriptRoot 'cli.mjs') 'quit-native' $request.configPath 2> (Join-Path $directory 'quit-stderr.log')
    if ($LASTEXITCODE -ne 0) { throw ([IO.File]::ReadAllText((Join-Path $directory 'quit-stderr.log'), $utf8)) }
    $quit = ($quitOutput | Out-String) | ConvertFrom-Json -AsHashtable
    if ($quit.quitRequested) { Receipt 'quit-requested' } else { Receipt 'quit-unconfirmed' $quit }
    # A refused/cancelled native quit must not leave a helper that reopens the app hours later.
    if (-not (Wait-CodexApplicationExit -TimeoutSeconds 60 -Processes $oldProcesses)) {
        $remaining = @(Get-CodexRemainingProcess -Processes $oldProcesses)
        Receipt 'cancelled' @{ reason = 'Codex remained open for 60 seconds; no process was stopped.'; processes = @($remaining | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath) }
        return
    }
    Receipt 'application-exited'
    & (Join-Path $PSScriptRoot 'start-toolkit.ps1') -ConfigPath $request.configPath -NodePath $request.nodeExecutable -PreviousLaunchId $previousLaunchId *> (Join-Path $directory 'launch.log')
    if ($LASTEXITCODE -ne 0) { throw ((Get-CodexText 'Toolkit launch failed. Log: {0}' 'Toolkit 启动失败。日志：{0}') -f (Join-Path $directory 'launch.log')) }
    $statusOutput = & $request.nodeExecutable (Join-Path $PSScriptRoot 'cli.mjs') 'status' $request.configPath 2> (Join-Path $directory 'status-stderr.log')
    if ($LASTEXITCODE -ne 0) { throw (Get-CodexText 'Codex reopened but Toolkit status could not be read.' 'Codex 已重新打开，但无法读取 Toolkit 状态。') }
    $status = ($statusOutput | Out-String) | ConvertFrom-Json -AsHashtable
    $configuration = [IO.File]::ReadAllText($request.configPath, $utf8) | ConvertFrom-Json -AsHashtable
    $stateDirectory = [IO.Path]::GetFullPath($configuration.stateDirectory, [IO.Path]::GetDirectoryName($request.configPath))
    $launch = [IO.File]::ReadAllText((Join-Path $stateDirectory 'last-launch.json'), $utf8) | ConvertFrom-Json -AsHashtable
    if ($status.phase -ne 'running' -or ($status.cdp -and -not $status.cdp.connected) -or $launch.stage -ne 'completed' -or $status.instanceId -cne $launch.result.instanceId) { throw (Get-CodexText 'The restart did not produce the expected running Toolkit instance.' '重启后未检测到预期的 Toolkit 实例。') }
    [IO.File]::WriteAllText((Join-Path $directory 'status.json'), ($status | ConvertTo-Json -Depth 20), $utf8)
    Receipt 'completed' @{ instanceId = $status.instanceId; launchId = $launch.id }
} catch {
    Receipt 'error' @{ message = $_.Exception.Message; detail = ($_ | Out-String) }
    $failure = $_
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $scheduler.GetFolder('\').DeleteTask($TaskName, 0)
}
if ($failure) {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show(($failure.Exception.Message + "`n`n" + (Get-CodexText 'Logs: ' '日志：') + $directory), (Get-CodexText 'CodexTopKits restart' 'CodexTopKits 重启'), 'OK', 'Error')
    throw $failure
}
