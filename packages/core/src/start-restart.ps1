#Requires -Version 7.0
param([Parameter(Mandatory)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$request = [IO.File]::ReadAllText($RequestPath, $utf8) | ConvertFrom-Json -AsHashtable
. (Join-Path $PSScriptRoot 'localization.ps1')
$configuration = [IO.File]::ReadAllText($request.configPath, $utf8) | ConvertFrom-Json -AsHashtable
$stateDirectory = [IO.Path]::GetFullPath($configuration.stateDirectory, [IO.Path]::GetDirectoryName($request.configPath))
$CodexLocale = Get-CodexLocale -StateDirectory $stateDirectory -ResolvedLocale $request.resolvedLocale
$directory = [IO.Path]::GetDirectoryName($RequestPath)
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$name = 'CodexTopKits-Restart-' + [guid]::NewGuid().ToString('N')
$definition = $scheduler.NewTask(0)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition.Principal.UserId = $user
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$definition.Settings.Hidden = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.ExecutionTimeLimit = 'PT0S'
$action = $definition.Actions.Create(0)
$action.Path = $request.powershellPath
$worker = Join-Path $PSScriptRoot 'restart-worker.ps1'
if ($RequestPath.Contains('"') -or $worker.Contains('"')) { throw (Get-CodexText 'Invalid restart helper path.' '重启助手路径无效。') }
$action.Arguments = '-NoProfile -NonInteractive -STA -WindowStyle Hidden -File "' + $worker + '" -RequestPath "' + $RequestPath + '" -TaskName "' + $name + '"'
$action.WorkingDirectory = $directory
$registered = $folder.RegisterTaskDefinition($name, $definition, 2, $user, $null, 3, $null)
try {
    [void]$registered.Run($null)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    # This bounds helper creation only; app exit and CDP startup have separate budgets.
    while (-not (Test-Path -LiteralPath (Join-Path $directory 'ready.json'))) {
        if (Test-Path -LiteralPath (Join-Path $directory 'error.json')) { throw ([IO.File]::ReadAllText((Join-Path $directory 'error.json'), $utf8)) }
        if ($watch.Elapsed.TotalSeconds -ge 60) { throw (Get-CodexText 'The restart helper did not become ready within 60 seconds.' '重启助手未在 60 秒内就绪。') }
        Start-Sleep -Milliseconds 100
    }
    [IO.File]::WriteAllText((Join-Path $directory 'go'), 'go', $utf8)
} catch {
    [IO.File]::WriteAllText((Join-Path $directory 'cancel'), 'cancel', $utf8)
    throw
}
