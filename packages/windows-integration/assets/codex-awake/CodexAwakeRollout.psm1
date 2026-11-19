Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'CodexAwakeDiagnostics.psm1')

$script:RolloutReadState = @{}
$script:RolloutFaults = @{}

if (-not ('CodexAwake.RolloutClock' -as [type])) {
  Add-Type @'
using System.Runtime.InteropServices;
namespace CodexAwake {
  public static class RolloutClock {
    [DllImport("kernel32.dll")]
    public static extern ulong GetTickCount64();
  }
}
'@
}

function Get-CodexAwakeSha256 {
  param([Parameter(Mandatory = $true)][string]$Value)

  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Read-CodexAwakeJson {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw
  }
}

function Write-CodexAwakeJsonAtomic {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )

  $tempPath = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  $json = $Value | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($tempPath, $json, (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $Path) {
    $backupPath = "$tempPath.bak"
    [IO.File]::Replace($tempPath, $Path, $backupPath)
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  } else {
    [IO.File]::Move($tempPath, $Path)
  }
}

function ConvertTo-CodexAwakeTerminalEvent {
  param(
    [Parameter(Mandatory = $true)]$Entry,
    [string]$SessionId
  )

  if ($Entry.type -ne 'event_msg' -or $null -eq $Entry.payload) {
    return $null
  }

  $payload = $Entry.payload
  $kindProperty = $payload.PSObject.Properties['type']
  if ($null -eq $kindProperty) { return $null }
  $kind = [string]$kindProperty.Value
  if ($kind -notin @('task_started', 'task_complete', 'turn_aborted')) { return $null }
  $turnProperty = $payload.PSObject.Properties['turn_id']
  if ($null -eq $turnProperty) { return $null }
  $turnId = [string]$turnProperty.Value
  if ([string]::IsNullOrWhiteSpace($turnId)) {
    return $null
  }

  switch ($kind) {
    'task_started' {
      return [pscustomobject]@{ Kind = 'started'; SessionId = $SessionId; TurnId = $turnId }
    }
    'task_complete' {
      $errorProperty = $payload.PSObject.Properties['error']
      $outcome = if ($null -ne $errorProperty -and $null -ne $errorProperty.Value) { 'failed' } else { 'completed' }
      return [pscustomobject]@{ Kind = $outcome; SessionId = $SessionId; TurnId = $turnId }
    }
    'turn_aborted' {
      $reasonProperty = $payload.PSObject.Properties['reason']
      if ($null -ne $reasonProperty -and [string]$reasonProperty.Value -eq 'interrupted') {
        return [pscustomobject]@{ Kind = 'aborted'; SessionId = $SessionId; TurnId = $turnId }
      }
    }
  }

  return $null
}

function Get-CodexAwakeCompleteLines {
  param(
    [Parameter(Mandatory = $true)][byte[]]$Bytes,
    [Parameter(Mandatory = $true)][int]$PreviousPartialLength
  )

  $lines = New-Object System.Collections.Generic.List[object]
  $lineStart = 0
  for ($index = 0; $index -lt $Bytes.Length; $index++) {
    if ($Bytes[$index] -ne 10) { continue }

    $lineLength = $index - $lineStart
    if ($lineLength -gt 0 -and $Bytes[$index - 1] -eq 13) { $lineLength-- }
    $lineBytes = New-Object byte[] $lineLength
    if ($lineLength -gt 0) {
      [Array]::Copy($Bytes, $lineStart, $lineBytes, 0, $lineLength)
    }
    $lines.Add([pscustomobject]@{
      Text = [Text.Encoding]::UTF8.GetString($lineBytes)
      EndIndexExclusive = $index + 1
    })
    $lineStart = $index + 1
  }

  $remainderLength = $Bytes.Length - $lineStart
  $remainder = New-Object byte[] $remainderLength
  if ($remainderLength -gt 0) {
    [Array]::Copy($Bytes, $lineStart, $remainder, 0, $remainderLength)
  }

  return [pscustomobject]@{
    Lines = $lines
    Remainder = $remainder
    PreviousPartialLength = $PreviousPartialLength
  }
}

function Test-CodexDesktopRollout {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    $firstLine = Get-Content -LiteralPath $Path -TotalCount 1 -ErrorAction Stop
    $meta = $firstLine | ConvertFrom-Json -ErrorAction Stop
    return $meta.type -eq 'session_meta' -and $meta.payload.originator -eq 'Codex Desktop'
  } catch {
    return $false
  }
}

function Get-CodexDesktopRolloutSessionId {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    $firstLine = Get-Content -LiteralPath $Path -TotalCount 1 -ErrorAction Stop
    $meta = $firstLine | ConvertFrom-Json -ErrorAction Stop
    if ($meta.type -ne 'session_meta' -or $meta.payload.originator -ne 'Codex Desktop') { return $null }
    $sessionId = [string]$meta.payload.id
    if ([string]::IsNullOrWhiteSpace($sessionId)) { return $null }
    return $sessionId
  } catch {
    return $null
  }
}

function Sync-CodexAwakeRollout {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$StateDirectory,
    [string]$RolloutRoot = (Join-Path $env:USERPROFILE '.codex\sessions'),
    [ValidateRange(1, 72)][int]$TtlHours = 12
  )

  if (-not (Test-Path -LiteralPath $RolloutRoot)) { return }
  New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
  $statePath = Join-Path $StateDirectory 'active.json'
  $checkpointPath = Join-Path $StateDirectory 'rollout-checkpoint.json'
  $checkpoint = Read-CodexAwakeJson -Path $checkpointPath
  $checkpointFiles = [ordered]@{}
  if ($null -ne $checkpoint -and $null -ne $checkpoint.files) {
    foreach ($property in $checkpoint.files.PSObject.Properties) {
      $checkpointFiles[$property.Name] = $property.Value
    }
  }

  $files = Get-ChildItem -LiteralPath $RolloutRoot -Recurse -File -Filter 'rollout-*.jsonl' -ErrorAction SilentlyContinue |
    Where-Object { Test-CodexDesktopRollout -Path $_.FullName }
  $events = New-Object System.Collections.Generic.List[object]
  $checkpointUpdates = [ordered]@{}

  foreach ($file in $files) {
    $rolloutSessionId = Get-CodexDesktopRolloutSessionId -Path $file.FullName
    $identity = Get-CodexAwakeSha256 -Value $file.FullName
    if ($script:RolloutFaults.ContainsKey($identity)) { continue }
    if (-not $checkpointFiles.Contains($identity)) {
      # First ownership starts at EOF so historic conversations cannot look newly active.
      $checkpointFiles[$identity] = [ordered]@{ offset = [int64]$file.Length; updatedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
      $checkpointUpdates[$identity] = [int64]$file.Length
      $script:RolloutReadState.Remove($identity)
      continue
    }

    $confirmedOffset = [int64]$checkpointFiles[$identity].offset
    if ($file.Length -lt $confirmedOffset) {
      # A truncation or replacement must replay the current file projection from its beginning.
      $confirmedOffset = 0
      $script:RolloutReadState.Remove($identity)
    }

    $runtime = $script:RolloutReadState[$identity]
    if ($null -eq $runtime) {
      if ($confirmedOffset -gt 0) {
        $boundary = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
          [void]$boundary.Seek($confirmedOffset - 1, [IO.SeekOrigin]::Begin)
          $onBoundary = $boundary.ReadByte() -eq 10
        } finally { $boundary.Dispose() }
        if (-not $onBoundary) {
          # A rewritten rollout can still be larger than the old offset. Do not
          # parse a partial record or replay old starts: establish a fresh EOF baseline.
          Write-CodexAwakeDiagnostic $StateDirectory 'rollout-checkpoint-rebased' @{ path = $file.FullName; oldOffset = $confirmedOffset; newOffset = $file.Length; reason = 'offset-not-at-line-boundary' }
          $checkpointUpdates[$identity] = [int64]$file.Length
          continue
        }
      }
      $runtime = [pscustomobject]@{ ReadOffset = $confirmedOffset; Partial = [byte[]]@() }
      $script:RolloutReadState[$identity] = $runtime
    }
    if ([int64]$runtime.ReadOffset -lt $confirmedOffset -or $file.Length -lt [int64]$runtime.ReadOffset) {
      $runtime.ReadOffset = $confirmedOffset
      $runtime.Partial = [byte[]]@()
    }
    if ($file.Length -eq [int64]$runtime.ReadOffset) { continue }

    $newBytes = $null
    try {
      $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      try {
        [void]$stream.Seek([int64]$runtime.ReadOffset, [IO.SeekOrigin]::Begin)
        $length = [int]($stream.Length - [int64]$runtime.ReadOffset)
        $newBytes = New-Object byte[] $length
        $read = 0
        while ($read -lt $length) {
          $count = $stream.Read($newBytes, $read, $length - $read)
          if ($count -le 0) { break }
          $read += $count
        }
        if ($read -lt $length) { $newBytes = $newBytes[0..($read - 1)] }
        $runtime.ReadOffset += $read
      } finally {
        $stream.Dispose()
      }
    } catch [IO.FileNotFoundException] {
      continue
    } catch [IO.DirectoryNotFoundException] {
      continue
    }

    $previousPartialLength = $runtime.Partial.Length
    $combined = New-Object byte[] ($previousPartialLength + $newBytes.Length)
    if ($previousPartialLength -gt 0) { [Array]::Copy($runtime.Partial, 0, $combined, 0, $previousPartialLength) }
    if ($newBytes.Length -gt 0) { [Array]::Copy($newBytes, 0, $combined, $previousPartialLength, $newBytes.Length) }
    $split = Get-CodexAwakeCompleteLines -Bytes $combined -PreviousPartialLength $previousPartialLength
    $committedNewBytes = 0
    $parseFailed = $false
    foreach ($line in $split.Lines) {
      if ([string]::IsNullOrWhiteSpace($line.Text)) {
        $committedNewBytes = $line.EndIndexExclusive
        continue
      }
      try {
        $entry = $line.Text | ConvertFrom-Json -ErrorAction Stop
      } catch {
        $script:RolloutFaults[$identity] = $_.Exception
        Write-CodexAwakeDiagnostic $StateDirectory 'rollout-file-quarantined' @{ path = $file.FullName; offset = $confirmedOffset; error = $_.Exception.ToString(); stack = $_.ScriptStackTrace }
        $parseFailed = $true
        break
      }
      $event = ConvertTo-CodexAwakeTerminalEvent -Entry $entry -SessionId $rolloutSessionId
      if ($null -ne $event) { $events.Add($event) }
      $committedNewBytes = $line.EndIndexExclusive
    }

    if ($parseFailed) {
      $failureStart = $committedNewBytes
      $remainderLength = $combined.Length - $failureStart
      $runtime.Partial = New-Object byte[] $remainderLength
      if ($remainderLength -gt 0) { [Array]::Copy($combined, $failureStart, $runtime.Partial, 0, $remainderLength) }
    } else {
      $runtime.Partial = $split.Remainder
    }
    $checkpointUpdates[$identity] = [int64]($confirmedOffset + $committedNewBytes)
  }

  if ($events.Count -eq 0 -and $checkpointUpdates.Count -eq 0) { return }

  $mutex = [Threading.Mutex]::new($false, (Get-CodexAwakeObjectName $StateDirectory 'State'))
  $lockTaken = $false
  try {
    try { $lockTaken = $mutex.WaitOne(2000) } catch [Threading.AbandonedMutexException] { $lockTaken = $true }
    if (-not $lockTaken) { throw 'Codex Awake rollout state lock was not acquired.' }

    $state = Read-CodexAwakeJson -Path $statePath
    $disabledProperty = if ($null -ne $state) { $state.PSObject.Properties['disabled'] } else { $null }
    if ($null -ne $disabledProperty -and $disabledProperty.Value -eq $true) { return }
    $active = [ordered]@{}
    $terminalTurns = [ordered]@{}
    if ($null -ne $state -and [int]$state.version -eq 3 -and $null -ne $state.active) {
      foreach ($property in $state.active.PSObject.Properties) { $active[$property.Name] = $property.Value }
    }
    $terminalProperty = $null
    if ($null -ne $state) { $terminalProperty = $state.PSObject.Properties['terminalTurns'] }
    if ($null -ne $state -and [int]$state.version -eq 3 -and $null -ne $terminalProperty -and $null -ne $terminalProperty.Value) {
      foreach ($property in $terminalProperty.Value.PSObject.Properties) { $terminalTurns[$property.Name] = $property.Value }
    }

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $cutoff = $now - ([int64]$TtlHours * 60 * 60 * 1000)
    $bootCutoff = $now - [int64][CodexAwake.RolloutClock]::GetTickCount64()
    $activeCutoff = [Math]::Max($cutoff, $bootCutoff)
    foreach ($key in @($active.Keys)) {
      $lastSeen = 0L
      try { $lastSeen = [int64]$active[$key].lastSeenUnixMs } catch {}
      if ($lastSeen -lt $activeCutoff) { $active.Remove($key) }
    }
    foreach ($key in @($terminalTurns.Keys)) {
      $lastSeen = 0L
      try { $lastSeen = [int64]$terminalTurns[$key].lastSeenUnixMs } catch {}
      if ($lastSeen -lt $cutoff) { $terminalTurns.Remove($key) }
    }

    $closedTurns = [Collections.Generic.List[object]]::new()
    foreach ($event in $events) {
      if ($event.Kind -eq 'started') {
        if ($terminalTurns.Contains($event.TurnId)) { continue }
        $matching = @($active.Keys | Where-Object {
          try { [string]$active[$_].turnId -eq $event.TurnId } catch { $false }
        })
        if ($matching.Count -eq 0) {
          $active["rollout:$($event.TurnId)"] = [ordered]@{
            lastSeenUnixMs = $now
            isSubagent = $false
            agentType = $null
            sessionId = $event.SessionId
            turnId = $event.TurnId
            source = 'rollout'
          }
        } else {
          foreach ($key in $matching) { $active[$key].lastSeenUnixMs = $now }
        }
        continue
      }

      if ($terminalTurns.Contains($event.TurnId)) {
        # Keep the first terminal result; repeats and conflicting terminals cannot revive activity.
        continue
      }
      $terminalTurns[$event.TurnId] = [ordered]@{ sessionId = $event.SessionId; turnId = $event.TurnId; outcome = $event.Kind; lastSeenUnixMs = $now }
      $closedTurns.Add(@{ sessionId = $event.SessionId; turnId = $event.TurnId; outcome = $event.Kind; source = 'rollout' })
      foreach ($key in @($active.Keys)) {
        try {
          if ([string]$active[$key].turnId -eq $event.TurnId) { $active.Remove($key) }
        } catch {}
      }
    }

    $newState = [ordered]@{
      version = 3
      disabled = $false
      updatedAtUnixMs = $now
      bootTimeUnixMs = $bootCutoff
      active = $active
      terminalTurns = $terminalTurns
    }
    Write-CodexAwakeJsonAtomic -Path $statePath -Value $newState
    if ($closedTurns.Count -gt 0) { Write-CodexAwakeDiagnostic $StateDirectory 'turns-closed' @($closedTurns.ToArray()) }

    foreach ($identity in $checkpointUpdates.Keys) {
      $checkpointFiles[$identity] = [ordered]@{ offset = $checkpointUpdates[$identity]; updatedAtUnixMs = $now }
    }
    $newCheckpoint = [ordered]@{
      version = 1
      updatedAtUnixMs = $now
      files = $checkpointFiles
    }
    Write-CodexAwakeJsonAtomic -Path $checkpointPath -Value $newCheckpoint
  } finally {
    if ($lockTaken) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

Export-ModuleMember -Function Sync-CodexAwakeRollout
