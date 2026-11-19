import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const quote = value => "'" + value.replaceAll("'", "''") + "'";
const hash = value => createHash('sha256').update(value).digest('hex');

export async function prepareEntries({ configPath, powershellPath, nodeExecutable = process.execPath }) {
  const directory = path.dirname(configPath), receipt = path.join(directory, '.toolkit-entries.json');
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  if (!path.isAbsolute(powershellPath ?? '') || /["\r\n%]/.test(powershellPath)) throw new Error('Configure an absolute standalone PowerShell 7 executable path before preparing launch entries.');
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(receipt, 'utf8')).files; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const common = `#Requires -Version 7.0\n$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)\n$OutputEncoding = [Text.UTF8Encoding]::new($false, $true)\n$node = ${quote(nodeExecutable)}\n$cli = ${quote(cli)}\n$config = ${quote(configPath)}\n. ${quote(fileURLToPath(new URL('./localization.ps1', import.meta.url)))}\nfunction Invoke-Toolkit([string]$Action) {\n    $result = & $node $cli $Action $config 2>&1\n    if ($LASTEXITCODE -ne 0) { throw ($result | Out-String) }\n    return (($result | Out-String) | ConvertFrom-Json)\n}\ntry {\n    $settings = [IO.File]::ReadAllText($config, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json -AsHashtable\n    $stateDirectory = [IO.Path]::GetFullPath($settings.stateDirectory, [IO.Path]::GetDirectoryName($config))\n    $CodexLocale = Get-CodexLocale -StateDirectory $stateDirectory\n    $runtime = Invoke-Toolkit 'status'\n    if ($runtime.phase -eq 'stopped') {\n        Write-Host (Get-CodexText 'Starting local Toolkit services…' '正在启动本地工具服务…')\n        $runtime = Invoke-Toolkit 'start'\n    }\n    if ($runtime.hostLanguage) { $CodexLocale = Get-CodexLocale -StateDirectory $stateDirectory -SystemLanguage $runtime.hostLanguage }\n`;
  const end = `} catch {\n    Write-Host ((Get-CodexText 'The operation did not complete: ' '操作未完成：') + $_.Exception.Message) -ForegroundColor Red\n    Write-Host (Get-CodexText 'Details are in the logs under stateDirectory in the configuration.' '详细错误保留在配置文件 stateDirectory 指定的日志目录。')\n    [void](Read-Host (Get-CodexText 'Press Enter to close' '按 Enter 关闭'))\n    exit 1\n}\n`;
  const files = {
    'launch-main.ps1': `#Requires -Version 7.0\n& (Join-Path $PSScriptRoot 'start-toolkit.ps1') -PauseOnFailure\nexit $LASTEXITCODE\n`,
    'start-toolkit.ps1': `#Requires -Version 7.0\nparam([switch]$PauseOnFailure)\n$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)\n. ${quote(fileURLToPath(new URL('./localization.ps1', import.meta.url)))}\ntry {\n    $settings = [IO.File]::ReadAllText(${quote(configPath)}, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json -AsHashtable\n    $stateDirectory = [IO.Path]::GetFullPath($settings.stateDirectory, [IO.Path]::GetDirectoryName(${quote(configPath)}))\n    $CodexLocale = Get-CodexLocale -StateDirectory $stateDirectory\n    & ${quote(fileURLToPath(new URL('./start-toolkit.ps1', import.meta.url)))} -ConfigPath ${quote(configPath)} -NodePath ${quote(nodeExecutable)}\n    exit $LASTEXITCODE\n} catch {\n    Write-Host $_.Exception.Message -ForegroundColor Red\n    if ($PauseOnFailure) { [void](Read-Host (Get-CodexText 'Press Enter to close' '按 Enter 关闭')) }\n    throw\n}\n`,
    'open-manager.ps1': common + `    if (-not $runtime.managerUrl) { throw (Get-CodexText 'No settings address is available. Update the local Toolkit services.' '服务未提供管理页地址，请先更新本地工具服务。') }\n    Start-Process -FilePath $runtime.managerUrl\n    Write-Host (Get-CodexText 'Settings opened.' '管理页已打开。')\n` + end,
  };
  for (const name of ['start-toolkit', 'open-manager']) files[name + '.cmd'] = `@echo off\r\nchcp 65001 >nul\r\nif not exist "${powershellPath}" (\r\n    echo PowerShell 7 was not found.\r\n    echo Path: "${powershellPath}"\r\n    echo Update powershellPath in toolkit.json, then run prepare again.\r\n    pause\r\n    exit /b 1\r\n)\r\n"${powershellPath}" -NoLogo -NoProfile -File "%~dp0${name}.ps1"${name === 'start-toolkit' ? ' -PauseOnFailure' : ''}\r\n`;
  for (const [name, contents] of Object.entries(files)) {
    let existing;
    try { existing = await fs.readFile(path.join(directory, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && ![previous[name], hash(contents)].includes(hash(existing))) throw new Error('An existing entry has local edits or belongs to another installation: ' + name);
  }
  for (const [name, contents] of Object.entries(files)) await fs.writeFile(path.join(directory, name), contents, 'utf8');
  await fs.writeFile(receipt, JSON.stringify({ preparedAt: new Date().toISOString(), files: Object.fromEntries(Object.entries(files).map(([name, contents]) => [name, hash(contents)])) }, null, 2) + '\n', 'utf8');
  return { directory, entries: Object.keys(files) };
}
