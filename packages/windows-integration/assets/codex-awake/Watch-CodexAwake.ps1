[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$StateDirectory,
  [ValidateRange(2, 300)]
  [int]$PollSeconds = 10,

  [ValidateRange(1, 72)]
  [int]$TtlHours = 12,

  [ValidateRange(5, 600)]
  [int]$IdleExitSeconds = 30
)

$ErrorActionPreference = 'Stop'
$stateDirectory = [IO.Path]::GetFullPath($StateDirectory)
$statePath = Join-Path $stateDirectory 'active.json'
$rolloutModulePath = Join-Path $PSScriptRoot 'CodexAwakeRollout.psm1'
$rolloutReconciliationAvailable = $false
Import-Module (Join-Path $PSScriptRoot 'CodexAwakeDiagnostics.psm1') -Force
$watcherMutex = [Threading.Mutex]::new($false, (Get-CodexAwakeObjectName $stateDirectory 'Watcher'))
$watcherLockTaken = $false
$changed = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, (Get-CodexAwakeObjectName $stateDirectory 'Changed'))

if (-not ('CodexAwake.Native' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace CodexAwake {
  public static class Native {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
    [DllImport("kernel32.dll")]
    public static extern ulong GetTickCount64();
  }
}
'@
}

$ES_CONTINUOUS = [Convert]::ToUInt32('80000000', 16)
$ES_SYSTEM_REQUIRED = [uint32]0x00000001
$held = $false
$idleSinceUnixMs = $null

try {
  if (Test-Path -LiteralPath $rolloutModulePath) {
    Import-Module -Name $rolloutModulePath -Force -ErrorAction Stop
    $rolloutReconciliationAvailable = $true
  }
} catch {
  Write-CodexAwakeDiagnostic $stateDirectory 'rollout-import-failed' @{ message = $_.Exception.Message; stack = $_.ScriptStackTrace }
}

try {
  try { $watcherLockTaken = $watcherMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $watcherLockTaken = $true }
  if (-not $watcherLockTaken) {
    exit 0
  }

  while ($true) {
    try {
      $current = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop } else { $null }
      if ($null -ne $current -and $current.disabled -eq $true) {
        $stateMutex = [Threading.Mutex]::new($false, (Get-CodexAwakeObjectName $stateDirectory 'State'))
        $stateLockTaken = $false
        try {
          try { $stateLockTaken = $stateMutex.WaitOne(2000) } catch [Threading.AbandonedMutexException] { $stateLockTaken = $true }
          if (-not $stateLockTaken) { throw 'Codex Awake state lock was not acquired.' }
          $current = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
          if ($current.disabled -eq $true) {
            $watcherMutex.ReleaseMutex(); $watcherLockTaken = $false
            break
          }
        } finally {
          if ($stateLockTaken) { $stateMutex.ReleaseMutex() }
          $stateMutex.Dispose()
        }
      }
    } catch {
      Write-CodexAwakeDiagnostic $stateDirectory 'state-read-failed' @{ message = $_.Exception.Message; stack = $_.ScriptStackTrace }
      throw
    }
    try {
      if ($rolloutReconciliationAvailable) {
        Sync-CodexAwakeRollout -StateDirectory $stateDirectory -TtlHours $TtlHours
      }
    } catch {
      Write-CodexAwakeDiagnostic $stateDirectory 'rollout-sync-failed' @{ message = $_.Exception.Message; stack = $_.ScriptStackTrace }
      # Unknown parser failures are not retried forever. Hooks/native sync still work.
      $rolloutReconciliationAvailable = $false
    }

    $readSucceeded = $false
    $activeCount = 0
    try {
      if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $ttlCutoff = $now - ([int64]$TtlHours * 60 * 60 * 1000)
        $bootCutoff = $now - [int64][CodexAwake.Native]::GetTickCount64()
        $cutoff = [Math]::Max($ttlCutoff, $bootCutoff)
        foreach ($property in @($state.active.PSObject.Properties)) {
          if ([int64]$property.Value.lastSeenUnixMs -ge $cutoff) {
            $activeCount++
          }
        }
      }
      $readSucceeded = $true
    } catch {
      Write-CodexAwakeDiagnostic $stateDirectory 'state-read-failed' @{ message = $_.Exception.Message; stack = $_.ScriptStackTrace }
      throw
    }

    if ($readSucceeded) {
      if ($activeCount -gt 0) {
        $result = [CodexAwake.Native]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
        if ($result -eq 0) { throw 'Windows rejected the Codex Awake wake assertion.' }
        if (-not $held) { Write-CodexAwakeDiagnostic $stateDirectory 'wake-held' @{ activeCount = $activeCount } }
        $held = $true
        $idleSinceUnixMs = $null
      } elseif ($held) {
        [void][CodexAwake.Native]::SetThreadExecutionState($ES_CONTINUOUS)
        $held = $false
        Write-CodexAwakeDiagnostic $stateDirectory 'wake-released' @{ activeCount = 0 }
        $idleSinceUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      } elseif ($null -eq $idleSinceUnixMs) {
        $idleSinceUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      } elseif (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $idleSinceUnixMs) -ge ($IdleExitSeconds * 1000)) {
        break
      }
    }

    [void]$changed.WaitOne($PollSeconds * 1000)
  }
} finally {
  if ($held) {
    [void][CodexAwake.Native]::SetThreadExecutionState($ES_CONTINUOUS)
  }
  if ($watcherLockTaken) { $watcherMutex.ReleaseMutex() }
  $watcherMutex.Dispose()
  $changed.Dispose()
}
