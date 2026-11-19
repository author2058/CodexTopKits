#Requires -Version 7.0
param([switch]$AssertExited)
. (Join-Path $PSScriptRoot 'localization.ps1')
function Get-CodexApplicationProcess {
    param([switch]$ForExitWait)
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction Stop | Where-Object SessionId -EQ $sessionId)
    foreach ($process in $processes) {
        if (-not $process.ExecutablePath) {
            # An exiting process can lose its path before its PID disappears; waiting grants no activation or stop authority.
            if ($ForExitWait) { $process; continue }
            $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.ProcessId) -ErrorAction Stop
            if (-not $current -or $current.SessionId -ne $sessionId -or ($null -ne $process.CreationDate -and $null -ne $current.CreationDate -and $current.CreationDate -ne $process.CreationDate)) { continue }
            $process = $current
        }
        if (-not $process.ExecutablePath) {
            throw ((Get-CodexText 'Cannot verify ChatGPT process {0}.' '无法验证 ChatGPT 进程 {0}。') -f $process.ProcessId)
        }
        if ($process.ExecutablePath -match '[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$') { $process }
    }
}
function Get-CodexRemainingProcess {
    param([object[]]$Processes)
    $current = @(Get-CodexApplicationProcess -ForExitWait)
    @($Processes | ForEach-Object { $old = $_; $current | Where-Object { $_.ProcessId -eq $old.ProcessId -and ($null -eq $old.CreationDate -or $null -eq $_.CreationDate -or $_.CreationDate -eq $old.CreationDate) } })
}
function Wait-CodexApplicationExit {
    param([int]$TimeoutSeconds = 0, [object[]]$Processes)
    if (-not $PSBoundParameters.ContainsKey('Processes')) { $Processes = @(Get-CodexApplicationProcess -ForExitWait) }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $shown = $false
    while ($true) {
        $remaining = @(Get-CodexRemainingProcess -Processes $Processes)
        if (-not $remaining.Count) { return $true }
        if (-not $shown) { Write-Host (Get-CodexText 'Waiting for Codex to exit. Press Ctrl+C to cancel.' '正在等待 Codex 退出。按 Ctrl+C 取消。'); $shown = $true }
        if ($TimeoutSeconds -gt 0 -and $watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) { return $false }
        Start-Sleep -Milliseconds 250
    }
}
function Assert-CodexApplicationExited {
    param([string]$Message = (Get-CodexText 'Codex is still running; no Toolkit files were changed.' 'Codex 仍在运行，Toolkit 文件未发生更改。'))
    if (@(Get-CodexApplicationProcess).Count) { throw $Message }
}
if ($AssertExited) { Assert-CodexApplicationExited }
