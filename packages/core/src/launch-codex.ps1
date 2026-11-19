#Requires -Version 7.0
param([string]$ResultPath, [switch]$OneTimeRestart, [string]$StateDirectory)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'application-process.ps1')
$CodexLocale = Get-CodexLocale -StateDirectory $StateDirectory

function New-CodexToolkitStartInfo {
    param(
        [string]$AliasPath = (Join-Path $env:LOCALAPPDATA 'Microsoft/WindowsApps/OpenAI.Codex_2p2nqsd0c76g0/chatgpt-desktop.exe'),
        [hashtable]$LaunchEnvironment = @{},
        [string]$DebugPort = $env:CODEX_TOOLKIT_CDP_PORT
    )
    if (-not (Test-Path -LiteralPath $AliasPath)) { throw ((Get-CodexText 'The registered Codex launch alias does not exist: {0}' 'Codex 注册的启动别名不存在：{0}') -f $AliasPath) }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $AliasPath
    $start.UseShellExecute = $false
    foreach ($name in $LaunchEnvironment.Keys) { $start.Environment[$name] = [string]$LaunchEnvironment[$name] }
    if ($DebugPort) {
        $portNumber = 0
        if (-not [int]::TryParse($DebugPort, [ref]$portNumber) -or $portNumber -lt 1024 -or $portNumber -gt 65535) { throw (Get-CodexText 'The local debugging port configuration is invalid.' '本机调试端口配置无效。') }
        $start.ArgumentList.Add('--remote-debugging-address=127.0.0.1')
        $start.ArgumentList.Add('--remote-debugging-port=' + $portNumber)
    }
    return $start
}

function Invoke-CodexApplicationLaunch {
    param([string]$ResultPath, [switch]$OneTimeRestart)
    if (-not $ResultPath) { throw (Get-CodexText 'The launch helper is missing a result file path.' '启动助手缺少结果文件路径。') }
    $OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
    if (-not $OneTimeRestart) { $null = Wait-CodexApplicationExit }
    # The registered execution alias preserves MSIX identity and the child environment.
    $start = New-CodexToolkitStartInfo
    if ($OneTimeRestart) { Assert-CodexApplicationExited -Message (Get-CodexText 'Another Codex instance opened while restarting. Its work was left running.' '重启期间另一个 Codex 实例已打开，仍保持运行。') }
    else { Assert-CodexApplicationExited -Message (Get-CodexText 'Another Codex instance opened before startup. Its work was left running.' '启动前另一个 Codex 实例已打开，仍保持运行。') }
    $process = [Diagnostics.Process]::Start($start)
    [IO.File]::WriteAllText($ResultPath, (@{ pid = $process.Id; launched = $true } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false, $true))
}
if ($MyInvocation.InvocationName -ne '.') { Invoke-CodexApplicationLaunch -ResultPath $ResultPath -OneTimeRestart:$OneTimeRestart }
