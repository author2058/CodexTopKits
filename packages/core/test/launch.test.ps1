$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../src/launch-codex.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors -or $ast.ScriptRequirements.RequiredPSVersion -ne [version]'7.0') { throw 'The launcher must declare PowerShell 7.' }
. (Join-Path $PSScriptRoot '../src/launch-codex.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('toolkit-launch-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$alias = Join-Path $root 'fixture-alias.exe'
[IO.File]::WriteAllBytes($alias, [byte[]]@())
try {
    $registered = New-CodexToolkitStartInfo
    $expectedAlias = Join-Path $env:LOCALAPPDATA 'Microsoft/WindowsApps/OpenAI.Codex_2p2nqsd0c76g0/chatgpt-desktop.exe'
    if ($registered.FileName -ne $expectedAlias -or $registered.UseShellExecute) { throw 'Default registered activation target changed.' }
    $before = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_OPENAI_BASE_URL', 'Process')
    $settings = New-CodexToolkitStartInfo -AliasPath $alias -LaunchEnvironment @{
        CODEX_APP_SERVER_OPENAI_BASE_URL = 'https://127.0.0.1:12345/synthetic/backend-api/codex'
        CODEX_CA_CERTIFICATE = (Join-Path $root 'synthetic-cert.pem')
    }
    if ($settings.FileName -ne $alias -or $settings.UseShellExecute) { throw 'Registered activation target changed.' }
    if ($settings.Environment['CODEX_APP_SERVER_OPENAI_BASE_URL'] -ne 'https://127.0.0.1:12345/synthetic/backend-api/codex') { throw 'Child route missing.' }
    if ([Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_OPENAI_BASE_URL', 'Process') -ne $before) { throw 'Route escaped child environment.' }
    if ($settings.ArgumentList.Count -ne 0) { throw 'Debugging was enabled without requesting it.' }
    $debugSettings = New-CodexToolkitStartInfo -AliasPath $alias -DebugPort '51423'
    if ($debugSettings.ArgumentList.Count -ne 2 -or $debugSettings.ArgumentList[1] -cne '--remote-debugging-port=51423') { throw 'Optional loopback debugging arguments are missing.' }
    Write-Output 'Passed registered-alias target and child-only environment checks. No application launched.'
} finally {
    Remove-Item -LiteralPath $alias -ErrorAction Stop
    Remove-Item -LiteralPath $root -ErrorAction Stop
}
