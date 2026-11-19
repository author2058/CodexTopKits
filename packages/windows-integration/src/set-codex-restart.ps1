[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateRange(1024,65535)] [int]$CdpPort,
    [uint32]$ProcessId,
    [switch]$ReadOnly,
    [switch]$VerifyProcessOnly
)
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
function Get-RestartArguments([string]$Existing, [int]$Port) {
    $preserved = [regex]::Replace($Existing, '(?<!\S)--remote-(?:debugging-address|debugging-port|allow-origins)=\S+', '').Trim()
    $cdp = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port --remote-allow-origins=http://127.0.0.1:$Port"
    return (@($preserved, $cdp) | Where-Object { $_ }) -join ' '
}
function Get-RestartReadFailure([Exception]$Failure) {
    $native = $Failure
    if ($native -is [Management.Automation.MethodInvocationException]) { $native = $native.InnerException }
    if ($native -isnot [Runtime.InteropServices.COMException] -or $native.HResult -ne -2147023728) { return $null }
    return @{ code='RESTART_NOT_REGISTERED'; hresult='0x80070490'; name=$Failure.GetType().FullName; message=$Failure.Message; stack=$Failure.ToString(); cause=@{ name=$native.GetType().FullName; message=$native.Message; hresult=$native.HResult } }
}
if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() -cne 'X64') { throw 'The restart registration helper currently requires Windows x64.' }
if (-not $ProcessId) {
    $owners = @(Get-NetTCPConnection -LocalPort $CdpPort -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) { throw 'The CDP listener does not have one process owner.' }
    $ProcessId = $owners[0]
}
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'restart-guard.cs'),$utf8))
$package = [CodexRestart.Native]::Package($ProcessId)
$manifest=[Xml.XmlDocument]::new()
$manifest.Load((Join-Path $package.installLocation 'AppxManifest.xml'))
if ($package.familyName -cne 'OpenAI.Codex_2p2nqsd0c76g0' -or $manifest.Package.Identity.Publisher -cne 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B') { throw 'The registered official Codex package identity changed.' }
$target = [Diagnostics.Process]::GetProcessById($ProcessId)
$expected = Join-Path $package.installLocation 'app\ChatGPT.exe'
if ($target.MainModule.FileName -ine $expected) { throw 'The target process is not the registered Codex executable.' }
$info = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
if (-not $info.CommandLine -or $info.CommandLine -match '--type=') { throw 'The target must be the Codex main process.' }
if ($VerifyProcessOnly) {
    [Console]::WriteLine((@{ verifiedNativeProcess=$true; pid=$ProcessId; startedAt=$target.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress))
    exit 0
}
$updaterPath=Join-Path $package.installLocation 'app/resources/native/windows-updater.node'
$flags = [uint32]0
try { $before = [CodexRestart.Native]::Read($ProcessId, [ref]$flags) }
catch {
    $failure = Get-RestartReadFailure $_.Exception
    if ($null -eq $failure) { throw }
    [Console]::WriteLine((@{ registered=$false; error=$failure; pid=$ProcessId; startedAt=$target.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 4 -Compress))
    exit 0
}
$originalFlags = $flags
$arguments = Get-RestartArguments $before $CdpPort
if ($ReadOnly) { $guard=[CodexRestart.Native]::InspectGuard($ProcessId,$updaterPath,$CdpPort) }
else {
    $guard=[CodexRestart.Native]::InstallGuard($ProcessId,$updaterPath,$CdpPort)
    # Exercise the actual updater import, preserving current official parameters
    # and flags. No update query, download, install, Quit or restart is invoked.
    [CodexRestart.Native]::RegisterThroughUpdater($ProcessId,$updaterPath,$arguments,$originalFlags)
    $guard=[CodexRestart.Native]::InspectGuard($ProcessId,$updaterPath,$CdpPort)
}
$after = [CodexRestart.Native]::Read($ProcessId, [ref]$flags)
if (-not $ReadOnly -and ($after -cne $arguments -or $flags -ne $originalFlags)) { throw 'Windows restart argument readback did not match.' }
if (-not $ReadOnly -and (-not $guard.hookInstalled -or -not $guard.hookVerified -or $guard.calls -lt 1 -or $guard.lastResult -ne 0)) { throw 'The native updater restart guard was not confirmed.' }
[Console]::WriteLine((@{ pid=$ProcessId; startedAt=$target.StartTime.ToUniversalTime().ToString('o'); arguments=$after; flags=$flags; registered=($after -ceq $arguments -and $flags -eq $originalFlags -and $guard.hookVerified); readOnly=[bool]$ReadOnly; hookInstalled=$guard.hookInstalled; hookVerified=$guard.hookVerified; hookVersion=$guard.hookVersion; hookAddress=$guard.hookAddress; calls=$guard.calls; lastFlags=$guard.lastFlags; lastResult=$guard.lastResult } | ConvertTo-Json -Compress))
