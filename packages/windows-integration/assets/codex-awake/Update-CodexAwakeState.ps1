[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'Interrupt', 'NativeSync')]
  [string]$EventName,

  [ValidateRange(1, 72)]
  [int]$TtlHours = 12,
  [Parameter(Mandatory = $true)]
  [string]$StateDirectory,
  [switch]$NoLaunchWatcher
)

# Hooks are short-lived. They only update durable activity state.
$ErrorActionPreference = 'Stop'
$shouldLaunchWatcher = $false
$stateDir = [IO.Path]::GetFullPath($StateDirectory)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSScriptRoot 'CodexAwakeDiagnostics.psm1') -Force

if (-not ('CodexAwake.HookClock' -as [type])) {
  Add-Type @'
using System.Runtime.InteropServices;
namespace CodexAwake {
  public static class HookClock {
    [DllImport("kernel32.dll")]
    public static extern ulong GetTickCount64();
  }
}
'@
}

function Get-HookString {
  param(
    [Parameter(Mandatory = $true)][string]$Raw,
    [Parameter(Mandatory = $true)][string]$Name
  )

  try {
    $json = $Raw | ConvertFrom-Json -ErrorAction Stop
    $value = $json.$Name
    if ($value -is [string] -and $value.Length -gt 0) {
      return $value
    }
  } catch {
    # Stop payloads can be truncated, so fall back to extracting only this field.
  }

  $pattern = '"' + [regex]::Escape($Name) + '"\s*:\s*"(?<value>(?:\\.|[^"\\])*)"'
  $match = [regex]::Match($Raw, $pattern)
  if (-not $match.Success) {
    return $null
  }

  try {
    $encoded = '"' + $match.Groups['value'].Value + '"'
    $value = $encoded | ConvertFrom-Json -ErrorAction Stop
    if ($value -is [string] -and $value.Length -gt 0) {
      return $value
    }
  } catch {
    return $null
  }

  return $null
}

try {
  $raw = [Console]::In.ReadToEnd()
  $native = if ($EventName -eq 'NativeSync') { $raw | ConvertFrom-Json -ErrorAction Stop } else { $null }
  $sessionId = Get-HookString -Raw $raw -Name 'session_id'
  $turnId = Get-HookString -Raw $raw -Name 'turn_id'
  if ($EventName -ne 'NativeSync' -and ([string]::IsNullOrWhiteSpace($sessionId) -or [string]::IsNullOrWhiteSpace($turnId))) {
    throw "$EventName payload is missing session_id or turn_id."
  }

  $agentType = Get-HookString -Raw $raw -Name 'agent_type'
  $key = "$sessionId`:$turnId"
  $statePath = Join-Path $stateDir 'active.json'
  $mutex = [Threading.Mutex]::new($false, (Get-CodexAwakeObjectName $stateDir 'State'))
  $lockTaken = $false

  try {
    try { $lockTaken = $mutex.WaitOne(2000) } catch [Threading.AbandonedMutexException] { $lockTaken = $true }
    if (-not $lockTaken) {
      throw 'Codex Awake state lock was not acquired.'
    }

    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $active = [ordered]@{}
    $terminalTurns = [ordered]@{}
    $disabled = $false
    if (Test-Path -LiteralPath $statePath) {
      try {
        $existing = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
        $disabled = $existing.disabled -eq $true
        if ([int]$existing.version -eq 3 -and $null -ne $existing.active) {
          foreach ($property in $existing.active.PSObject.Properties) {
            $active[$property.Name] = $property.Value
          }
        }
        $terminalProperty = $existing.PSObject.Properties['terminalTurns']
        if ([int]$existing.version -eq 3 -and $null -ne $terminalProperty -and $null -ne $terminalProperty.Value) {
          foreach ($property in $terminalProperty.Value.PSObject.Properties) {
            $terminalTurns[$property.Name] = $property.Value
          }
        }
      } catch {
        throw
      }
    }

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $cutoff = $now - ([int64]$TtlHours * 60 * 60 * 1000)
    $bootCutoff = $now - [int64][CodexAwake.HookClock]::GetTickCount64()
    $activeCutoff = [Math]::Max($cutoff, $bootCutoff)
    foreach ($existingKey in @($active.Keys)) {
      $lastSeen = 0L
      try { $lastSeen = [int64]$active[$existingKey].lastSeenUnixMs } catch {}
      if ($lastSeen -lt $activeCutoff) {
        $active.Remove($existingKey)
      }
    }
    foreach ($existingKey in @($terminalTurns.Keys)) {
      $lastSeen = 0L
      try { $lastSeen = [int64]$terminalTurns[$existingKey].lastSeenUnixMs } catch {}
      if ($lastSeen -lt $cutoff) {
        $terminalTurns.Remove($existingKey)
      }
    }

    $changes = [Collections.Generic.List[object]]::new()
    function Close-AwakeTurn([string]$Id, [string]$Session, [string]$Outcome, [string]$Source) {
      if ([string]::IsNullOrWhiteSpace($Id)) { throw 'Awake terminal event is missing turn ID.' }
      foreach ($entryKey in @($active.Keys)) {
        if ([string]$active[$entryKey].turnId -eq $Id) { $active.Remove($entryKey) }
      }
      if (-not $terminalTurns.Contains($Id)) {
        $terminalTurns[$Id] = [ordered]@{ sessionId = $Session; turnId = $Id; outcome = $Outcome; source = $Source; lastSeenUnixMs = $now }
        $changes.Add(@{ turnId = $Id; sessionId = $Session; outcome = $Outcome; source = $Source })
      }
    }
    if ($EventName -eq 'NativeSync' -and $native.disable -eq $true) {
      $disabled = $true
      $active.Clear()
    } elseif ($EventName -eq 'NativeSync') {
      $disabled = $false
      foreach ($event in @($native.events)) {
        if ([string]::IsNullOrWhiteSpace($event.threadId) -or [string]::IsNullOrWhiteSpace($event.turnId)) { throw 'Invalid native Awake turn identity.' }
        if ($event.method -eq 'turn/completed') {
          if ($event.outcome -notin @('completed', 'failed', 'interrupted')) { throw 'Invalid native Awake terminal status.' }
          Close-AwakeTurn $event.turnId $event.threadId $event.outcome 'native-event'
        } elseif ($event.method -eq 'turn/started') {
          if (-not $terminalTurns.Contains($event.turnId)) {
            $nativeKey = "$($event.threadId):$($event.turnId)"
            $active[$nativeKey] = [ordered]@{ sessionId = $event.threadId; turnId = $event.turnId; source = 'native'; lastSeenUnixMs = $now; isSubagent = $false }
          }
        } else { throw 'Unsupported native Awake event.' }
      }
      if ($null -ne $native.snapshot) {
        $snapshot = $native.snapshot
        if ($null -eq $snapshot.busyThreadIds -or $null -eq $snapshot.loadedThreadIds -or [long]$snapshot.startedAt -le 0) { throw 'Invalid native Awake snapshot.' }
        foreach ($entryKey in @($active.Keys)) {
          $entry = $active[$entryKey]
          if ($entry.sessionId -in $snapshot.busyThreadIds) {
            # A native-confirmed active thread must not expire during a long turn.
            $entry.lastSeenUnixMs = $now
          } elseif ([long]$entry.lastSeenUnixMs -lt [long]$snapshot.startedAt) {
            $outcome = if ($entry.sessionId -in $snapshot.loadedThreadIds) { 'reconciled-idle' } else { 'reconciled-unloaded' }
            if ($entry.turnId) { Close-AwakeTurn $entry.turnId $entry.sessionId $outcome 'native-snapshot' }
            else { $active.Remove($entryKey) }
          }
        }
        foreach ($threadId in $snapshot.busyThreadIds) {
          $matches = @($active.Values | Where-Object { $_.sessionId -eq $threadId })
          if ($matches.Count -eq 0) {
            $active["native-thread:$threadId"] = [ordered]@{ sessionId = $threadId; turnId = $null; source = 'native-snapshot'; lastSeenUnixMs = $now; isSubagent = $false }
          }
        }
      }
      $shouldLaunchWatcher = $active.Count -gt 0
    } elseif ($disabled) {
      $active.Clear()
    } elseif ($EventName -in @('UserPromptSubmit', 'SubagentStart')) {
      if ($terminalTurns.Contains($turnId)) {
        # A late Hook start cannot revive a rollout-confirmed terminal turn.
        $shouldLaunchWatcher = $false
      } else {
      $wasSubagent = $EventName -eq 'SubagentStart'
      $matchingKeys = @($active.Keys | Where-Object {
        try { [string]$active[$_].turnId -eq $turnId } catch { $false }
      })
      foreach ($matchingKey in $matchingKeys) {
        try { $wasSubagent = $wasSubagent -or [bool]$active[$matchingKey].isSubagent } catch {}
        $active.Remove($matchingKey)
      }
      $active[$key] = [ordered]@{
        lastSeenUnixMs = $now
        isSubagent = $wasSubagent
        agentType = if ([string]::IsNullOrWhiteSpace($agentType)) { $null } else { $agentType }
        sessionId = $sessionId
        turnId = $turnId
        source = 'hook'
      }
      $shouldLaunchWatcher = $true
      }
    } else {
      $outcome = if ($EventName -eq 'Interrupt') { 'interrupted' } else { 'completed' }
      Close-AwakeTurn $turnId $sessionId $outcome "hook:$EventName"
    }

    $state = [ordered]@{
      version = 3
      disabled = $disabled
      updatedAtUnixMs = $now
      bootTimeUnixMs = $bootCutoff
      active = $active
      terminalTurns = $terminalTurns
    }
    $tempPath = "$statePath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $json = $state | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($tempPath, $json, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $statePath) {
      $backupPath = "$tempPath.bak"
      [IO.File]::Replace($tempPath, $statePath, $backupPath)
      Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    } else {
      [IO.File]::Move($tempPath, $statePath)
    }
    if ($changes.Count -gt 0) { Write-CodexAwakeDiagnostic $stateDir 'turns-closed' @($changes.ToArray()) }
  } finally {
    if ($lockTaken) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }

  if (-not $NoLaunchWatcher) {
    $signal = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, (Get-CodexAwakeObjectName $stateDir 'Changed'))
    try { [void]$signal.Set() } finally { $signal.Dispose() }
  }
  if ($shouldLaunchWatcher -and -not $NoLaunchWatcher) {
    $watcherMutex = [Threading.Mutex]::new($false, (Get-CodexAwakeObjectName $stateDir 'Watcher'))
    $watcherMissing = $false
    try {
      try { $watcherMissing = $watcherMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $watcherMissing = $true }
      if ($watcherMissing) { $watcherMutex.ReleaseMutex() }
    } finally { $watcherMutex.Dispose() }
    if ($watcherMissing) {
      $watcherPath = Join-Path $PSScriptRoot 'Watch-CodexAwake.ps1'
      $powershellPath = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
      Start-Process -FilePath $powershellPath -ArgumentList @('-NoProfile', '-NonInteractive', '-File', ('"' + $watcherPath + '"'), '-StateDirectory', ('"' + $stateDir + '"')) -WindowStyle Hidden
    }
  }
} catch {
  Write-CodexAwakeDiagnostic $stateDir 'update-failed' @{ eventName = $EventName; message = $_.Exception.Message; type = $_.Exception.GetType().FullName; stack = $_.ScriptStackTrace }
  throw
}
