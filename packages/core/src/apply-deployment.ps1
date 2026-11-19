#Requires -Version 7.0
param([Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)][string]$NodePath, [switch]$Preflight)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'localization.ps1')
$action = if ($Preflight) { 'deployment-check' } else { 'deployment-apply' }
$output = & $NodePath (Join-Path $PSScriptRoot 'cli.mjs') $action $ConfigPath 2>&1
if ($LASTEXITCODE -ne 0) { throw (((Get-CodexText 'Toolkit deployment failed (exit {0}).' 'Toolkit 部署失败（退出代码 {0}）。') -f $LASTEXITCODE) + "`n" + ($output | Out-String).TrimEnd()) }
$output | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }
$output | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] }
