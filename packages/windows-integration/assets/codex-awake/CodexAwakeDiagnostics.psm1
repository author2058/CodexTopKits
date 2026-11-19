function Get-CodexAwakeObjectName {
  param([Parameter(Mandatory = $true)][string]$StateDirectory, [Parameter(Mandatory = $true)][string]$Kind)
  $path = [IO.Path]::GetFullPath($StateDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).ToUpperInvariant()
  $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($path)))
  return "Local\CodexAwake$Kind-$hash"
}

function Write-CodexAwakeDiagnostic {
  param([string]$StateDirectory, [string]$Event, $Details)
  [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
  $record = @{ timestamp = [DateTimeOffset]::Now.ToString('o'); pid = $PID; event = $Event; details = $Details }
  $line = ($record | ConvertTo-Json -Depth 8 -Compress) + "`n"
  $mutex = [Threading.Mutex]::new($false, (Get-CodexAwakeObjectName $StateDirectory 'Log'))
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(2000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Codex Awake diagnostic log lock was not acquired.' }
    [IO.File]::AppendAllText((Join-Path $StateDirectory 'awake.jsonl'), $line, [Text.UTF8Encoding]::new($false))
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
Export-ModuleMember -Function Write-CodexAwakeDiagnostic, Get-CodexAwakeObjectName
