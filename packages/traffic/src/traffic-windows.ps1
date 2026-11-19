param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [int]$ToolkitProcessId = 0,
    [string]$PowerShellPath = 'pwsh',
    [switch]$Elevate,
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
. (Join-Path $PSScriptRoot 'codex-processes.ps1')
if ($Elevate) {
    $arguments = @('-NoProfile', '-File', ('"' + $PSCommandPath + '"'), '-OutputDirectory', ('"' + $OutputDirectory + '"'), '-ToolkitProcessId', [string]$ToolkitProcessId)
    $child = Start-Process -FilePath $PowerShellPath -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru
    [pscustomobject]@{pid=$child.Id;directory=$OutputDirectory} | ConvertTo-Json -Compress
    exit
}
$nativeSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'traffic-windows.cs'),$utf8)
if($SelfTest){$nativeSource=$nativeSource.Replace('Global\CodexDynamicTheme-Network','Global\CodexDynamicTheme-Network-SelfTest')}
Add-Type -TypeDefinition $nativeSource
if ($SelfTest) {
    $data = [byte[]]::new(44)
    [BitConverter]::GetBytes([int]1234).CopyTo($data,0)
    [BitConverter]::GetBytes([uint32]4096).CopyTo($data,4)
    $endpoints = [byte[]]@(198,18,0,16,127,0,0,1,1,187,30,210)
    $endpoints.CopyTo($data,8)
    $send = [CodexWindowsTraffic]::Decode(10,0,$data)
    $receive = [CodexWindowsTraffic]::Decode(11,0,$data)
    if ($send.pid -ne 1234 -or $send.size -ne 4096 -or $send.remote -ne '198.18.0.16:443' -or $send.loopback) { throw 'TCP send decoding failed' }
    if ($receive.remote -ne '198.18.0.16:443' -or $receive.loopback -or $receive.send) { throw 'TCP receive decoding failed' }
    if ($null -ne [CodexWindowsTraffic]::Decode(12,0,$data)) { throw 'Non-data event was counted' }
    $schemaRejected = $false
    try { [void][CodexWindowsTraffic]::Decode(10,1,$data) } catch { if ($_.Exception.InnerException -is [InvalidOperationException]) { $schemaRejected = $true } else { throw } }
    if (-not $schemaRejected) { throw 'Unknown schema was accepted' }
    [byte[]]::new(32).CopyTo($data,8); $data[23] = 1; $data[40] = 1; $data[41] = 187
    $v6 = [CodexWindowsTraffic]::Decode(58,0,$data)
    if ($v6.remote -ne '[::1]:443' -or $v6.protocol -ne 'UDP' -or -not $v6.loopback) { throw 'IPv6 decoding failed' }
    $acquire=[CodexWindowsTraffic].GetMethod('AcquireOwnership',[Reflection.BindingFlags]'Instance,NonPublic')
    $first=[CodexWindowsTraffic]::new(); $second=[CodexWindowsTraffic]::new()
    try {
        $acquire.Invoke($first,@())
        $rejected=$false
        try { $acquire.Invoke($second,@()) }
        catch { if($_.Exception.InnerException -is [InvalidOperationException]){$rejected=$true}else{throw} }
        if(-not $rejected){throw 'A second monitor acquired the active trace ownership.'}
        $first.Dispose()
        $acquire.Invoke($second,@())
        if($first.SessionName -cne 'CodexDynamicTheme-Network' -or $second.SessionName -cne $first.SessionName){throw 'The ETW owner name must be stable.'}
    } finally { $first.Dispose(); $second.Dispose() }
    'PASS: Windows ETW TCP/UDP, IPv4/IPv6, direction, loopback, schema rejection'
    'PASS: exclusive trace ownership, release and stable native session name; no ETW session started'
    exit
}
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'OutputDirectory must be absolute.' }
[void][IO.Directory]::CreateDirectory($OutputDirectory)
$stopPath = Join-Path $OutputDirectory 'stop'
$toolkitCreatedAt = ''
if ($ToolkitProcessId -gt 0) {
    $toolkitOwner = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $ToolkitProcessId)
    if (-not $toolkitOwner -or $toolkitOwner.Name -ne 'node.exe') { throw 'The selected toolkit process is not running.' }
    $toolkitCreatedAt = $toolkitOwner.CreationDate.ToUniversalTime().ToString('O')
}
$writer = [IO.StreamWriter]::new((Join-Path $OutputDirectory 'windows-network.jsonl'),$true,$utf8)
$writer.AutoFlush = $true
$monitor = [CodexWindowsTraffic]::new()
$started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
function Write-Snapshot($value) {
    $json = ConvertTo-Json -InputObject $value -Compress -Depth 7
    $writer.WriteLine($json)
}
function Get-CodexProcessMap {
    $selected = @(Get-CodexTrafficProcesses -ToolkitProcessId $ToolkitProcessId -ToolkitCreatedAt $toolkitCreatedAt)
    $map = [Collections.Generic.Dictionary[int,string]]::new()
    foreach ($item in $selected) { $map[[int]$item.ProcessId] = $item.Name + '@' + $item.CreationDate.ToUniversalTime().ToString('O') }
    return ,$map
}
try {
    $monitor.SetProcesses((Get-CodexProcessMap))
    $monitor.Start()
    if ([IO.File]::Exists($stopPath)) { Remove-Item -LiteralPath $stopPath -ErrorAction Stop }
    $iteration = 0
    while (-not [IO.File]::Exists($stopPath)) {
        if ($iteration++ % 5 -eq 0) { $monitor.SetProcesses((Get-CodexProcessMap)) }
        $sample = $monitor.Read()
        Write-Snapshot @{type='sample';status='active';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();started=$started;pid=$PID;data=$sample}
        Start-Sleep -Milliseconds 1000
    }
    Write-Snapshot @{type='status';status='stopped';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();started=$started;pid=$PID}
} catch {
    Write-Snapshot @{type='error';status='error';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();pid=$PID;error=$_.ToString();detail=$_.ScriptStackTrace}
    throw
} finally {
    $monitor.Dispose()
    $writer.Dispose()
}
