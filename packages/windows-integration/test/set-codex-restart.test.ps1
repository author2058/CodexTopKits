param([uint32]$LiveProcessId,[int]$CdpPort)
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../src/set-codex-restart.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$definition=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-RestartArguments'},$false)
Invoke-Expression $definition[0].Extent.Text
$failureDefinition=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-RestartReadFailure'},$false)
Invoke-Expression $failureDefinition[0].Extent.Text
$missing=[Runtime.InteropServices.COMException]::new('Not registered yet.',-2147023728)
$wrapped=[Management.Automation.MethodInvocationException]::new('Original invocation diagnostics.',$missing)
$failure=Get-RestartReadFailure $wrapped
if($failure.code -cne 'RESTART_NOT_REGISTERED' -or $failure.hresult -cne '0x80070490' -or $failure.message -cne $wrapped.Message -or $failure.stack -cne $wrapped.ToString() -or $failure.cause.message -cne $missing.Message){throw 'The known transient restart error lost its diagnostics.'}
foreach($unexpected in @([Runtime.InteropServices.COMException]::new('Access denied.',-2147024891),[InvalidOperationException]::new('Unknown native failure.',$missing))){
    if($null -ne (Get-RestartReadFailure $unexpected)){throw 'An unexpected error was treated as registration pending.'}
}
$source=$ast.Extent.Text
if($source.IndexOf('if ($VerifyProcessOnly)') -lt $source.IndexOf("throw 'The target must be the Codex main process.'") -or $source.IndexOf('if ($VerifyProcessOnly)') -gt $source.IndexOf('[CodexRestart.Native]::Read(')){throw 'Process verification must retain ownership checks without reading or writing restart settings.'}
if($source.Contains('Get-AppxPackage') -or -not $source.Contains('[CodexRestart.Native]::Package($ProcessId)') -or -not $source.Contains('$manifest.Package.Identity.Publisher')){throw 'Package checks must use native identity and preserve the official publisher check.'}
$expected='--remote-debugging-address=127.0.0.1 --remote-debugging-port=60888 --remote-allow-origins=http://127.0.0.1:60888'
if ((Get-RestartArguments '' 60888) -cne $expected) { throw 'Incorrect restart arguments.' }
if ((Get-RestartArguments '--official-mode "keep this value"' 60888) -cne ('--official-mode "keep this value" '+$expected)) { throw 'Official arguments were not preserved.' }
if ((Get-RestartArguments $expected 60888) -cne $expected) { throw 'Registration is not idempotent.' }
if ((Get-RestartArguments $expected 60889) -match '60888') { throw 'A previous CDP port survived replacement.' }
$utf8=[Text.UTF8Encoding]::new($false,$true)
$nativeSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../src/restart-guard.cs'),$utf8)
$testSource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'restart-guard.test.cs'),$utf8)
Add-Type -TypeDefinition ($nativeSource+"`n"+$testSource)
[Console]::WriteLine([CodexRestart.GuardTests]::Run())
[Console]::WriteLine('Restart argument preservation and idempotence verified; no application registration or app restart invoked.')
if($LiveProcessId){
    if($CdpPort -lt 1024 -or $CdpPort -gt 65535){throw 'Live verification requires the intended CDP port.'}
    $package=[CodexRestart.Native]::Package($LiveProcessId)
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$LiveProcessId"
    if($process.ExecutablePath -ine (Join-Path $package.InstallLocation 'app/ChatGPT.exe') -or $process.CommandLine -match '--type='){
        throw 'Live verification requires the current official Codex main process.'
    }
    $updater=Join-Path $package.InstallLocation 'app/resources/native/windows-updater.node'
    $guard=[CodexRestart.Native]::InspectGuard($LiveProcessId,$updater,$CdpPort)
    if(-not $guard.hookVerified){throw 'Install and verify the restart guard before testing live calls.'}
    $beforeFlags=[uint32]0
    $before=[CodexRestart.Native]::Read($LiveProcessId,[ref]$beforeFlags)
    $records=@(); $failure=$null
    try {
        foreach($value in @('', 'codex://launch')){
            [CodexRestart.Native]::RegisterThroughUpdater($LiveProcessId,$updater,$value,0)
            $flags=[uint32]0; $actual=[CodexRestart.Native]::Read($LiveProcessId,[ref]$flags)
            $expected=Get-RestartArguments $value $CdpPort
            if($actual -cne $expected -or $flags -ne 0){throw 'The official updater registration would not retain CDP or its flags.'}
            $records+=@{input=$value;arguments=$actual;flags=$flags}
        }
    } catch { $failure=$_; throw }
    finally {
        # Remove only the synthetic URI/flags used by these two probes. The
        # deployed guard and the CDP registration remain installed afterwards.
        try {
            [CodexRestart.Native]::RegisterThroughUpdater($LiveProcessId,$updater,$before,$beforeFlags)
            $restoredFlags=[uint32]0; $retained=[CodexRestart.Native]::Read($LiveProcessId,[ref]$restoredFlags)
            if($retained -cne $before -or $restoredFlags -ne $beforeFlags){throw 'The live proof did not retain the intended restart settings.'}
        } catch { if($failure){$failure.Exception.Data['ProbeCleanupFailure']=$_.Exception}else{throw} }
    }
    [Console]::WriteLine((@{livePid=$LiveProcessId;cases=$records;retainedArguments=$retained;retainedFlags=$restoredFlags;guard=[CodexRestart.Native]::InspectGuard($LiveProcessId,$updater,$CdpPort)} | ConvertTo-Json -Depth 4 -Compress))
}
