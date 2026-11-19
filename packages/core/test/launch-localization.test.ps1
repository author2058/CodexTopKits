#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../src/localization.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('toolkit-language-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$path = Join-Path $root 'language.json'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
try {
    if ((Get-CodexLocale -StateDirectory $root -SystemLanguage 'zh-CN') -cne 'zh-Hans') { throw 'Auto mode must use the system UI language.' }
    if ((Get-CodexLocale -StateDirectory $root -SystemLanguage 'zh-TW') -cne 'en') { throw 'Traditional Chinese must fall back to English.' }
    if ((Get-CodexLocale -StateDirectory $root -SystemLanguage 'zh-MY') -cne 'zh-Hans') { throw 'Malaysian Chinese must resolve to Simplified Chinese.' }
    [IO.File]::WriteAllText($path, '{"mode":"fixed","locale":"zh-Hans"}', $utf8)
    if ((Get-CodexLocale -StateDirectory $root -SystemLanguage 'en-US') -cne 'zh-Hans') { throw 'Fixed Chinese preference was ignored.' }
    if ((Get-CodexLocale -StateDirectory $root -ResolvedLocale 'en' -SystemLanguage 'zh-CN') -cne 'en') { throw 'Resolved host locale was ignored.' }
    [IO.File]::WriteAllText($path, '{"mode":"fixed","locale":"en"}', $utf8)
    if ((Get-CodexLocale -StateDirectory $root -SystemLanguage 'zh-CN') -cne 'en') { throw 'Fixed English preference was ignored.' }
    [IO.File]::WriteAllText($path, '{"mode":"auto"}', $utf8)
    if ((Get-CodexLocale -StateDirectory $root -SystemLanguage 'zh-SG') -cne 'zh-Hans') { throw 'Auto preference did not follow the UI language.' }
    [IO.File]::WriteAllText($path, '{"mode":"fixed","locale":"zh-CN"}', $utf8)
    $failed = $false
    try { $null = Get-CodexLocale -StateDirectory $root } catch { $failed = $true }
    if (-not $failed) { throw 'Invalid preferences must remain visible.' }
    $CodexLocale = 'en'
    if ((Get-CodexText 'Open' '打开') -cne 'Open') { throw 'English text mismatch.' }
    $CodexLocale = 'zh-Hans'
    if ((Get-CodexText 'Open' '打开') -cne '打开') { throw 'Chinese text mismatch.' }
    . (Join-Path $PSScriptRoot '../src/launch-codex.ps1')
    foreach ($locale in @('en', 'zh-Hans')) {
        $CodexLocale = $locale
        $message = $null
        try { New-CodexToolkitStartInfo -AliasPath (Join-Path $root 'missing.exe') } catch { $message = $_.Exception.Message }
        $prefix = if ($locale -eq 'en') { 'The registered Codex launch alias does not exist:' } else { 'Codex 注册的启动别名不存在：' }
        if (-not $message.StartsWith($prefix)) { throw "Launch error did not use ${locale}: $message" }
    }
    foreach ($script in @('start-toolkit.ps1', 'start-restart.ps1', 'restart-worker.ps1', 'restart-confirmation.ps1', 'launch-codex.ps1', 'launch-lock.ps1', 'apply-deployment.ps1', 'application-process.ps1')) {
        $tokens = $null; $errors = $null
        [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot "../src/$script"), [ref]$tokens, [ref]$errors)
        if ($errors.Count) { throw "Parse failed for ${script}: $($errors.Message -join '; ')" }
    }
    Write-Output 'Launch localization checks passed without launching or restarting an application.'
} finally {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -ErrorAction Stop }
    Remove-Item -LiteralPath $root -ErrorAction Stop
}
