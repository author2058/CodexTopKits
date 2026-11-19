#Requires -Version 7.0
function Get-CodexLocale {
    param([string]$StateDirectory, [string]$ResolvedLocale, [string]$SystemLanguage = [cultureinfo]::CurrentUICulture.Name)
    if ($ResolvedLocale -cin @('en', 'zh-Hans')) { return $ResolvedLocale }
    if ($StateDirectory) {
        $path = Join-Path $StateDirectory 'language.json'
        try { $preference = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json -AsHashtable }
        catch [IO.FileNotFoundException] { $preference = @{ mode = 'auto' } }
        catch [IO.DirectoryNotFoundException] { $preference = @{ mode = 'auto' } }
        $auto = $false
        if ($preference -is [System.Collections.IDictionary] -and $preference.Keys -ccontains 'mode') {
            if ($preference.mode -ceq 'fixed' -and $preference.Keys -ccontains 'locale' -and $preference.locale -cin @('en', 'zh-Hans') -and $preference.Count -eq 2) { return $preference.locale }
            if ($preference.mode -ceq 'auto' -and $preference.Count -eq 1) { $auto = $true }
        }
        if (-not $auto) { throw (Get-CodexText 'Invalid language preference.' '语言首选项无效。') }
    }
    if ($SystemLanguage -match '^zh(?:$|-Hans(?:-|$)|-(?:CN|SG|MY)$)') { return 'zh-Hans' }
    return 'en'
}
function Get-CodexText {
    param([string]$English, [string]$Chinese)
    if ($CodexLocale -eq 'zh-Hans') { return $Chinese }
    if (-not $CodexLocale -and (Get-CodexLocale) -eq 'zh-Hans') { return $Chinese }
    return $English
}
