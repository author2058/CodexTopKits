$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../src/codex-processes.ps1')
$created = [datetime]'2026-11-09T00:00:00Z'
$processes = @(
    [pscustomobject]@{ ProcessId=101; ParentProcessId=0; Name='ChatGPT.exe'; ExecutablePath='C:\Program Files\WindowsApps\OpenAI.Codex_0_x64__fixture\app\ChatGPT.exe'; CreationDate=$created },
    [pscustomobject]@{ ProcessId=102; ParentProcessId=101; Name='fixture.exe'; ExecutablePath='C:\fixture.exe'; CreationDate=$created.AddSeconds(1) },
    [pscustomobject]@{ ProcessId=103; ParentProcessId=101; Name='unrelated.exe'; ExecutablePath='C:\unrelated.exe'; CreationDate=$created.AddSeconds(-1) },
    [pscustomobject]@{ ProcessId=201; ParentProcessId=0; Name='node.exe'; ExecutablePath='C:\node.exe'; CreationDate=$created }
)
$selected = @(Select-CodexTrafficProcesses -Processes $processes -ToolkitProcessId 201 -ToolkitCreatedAt $created.ToUniversalTime().ToString('O'))
if (($selected.ProcessId | Sort-Object) -join ',' -cne '101,102,201') { throw 'Process ownership or child identity selection failed.' }
$reused = @(Select-CodexTrafficProcesses -Processes $processes -ToolkitProcessId 201 -ToolkitCreatedAt $created.AddSeconds(-1).ToUniversalTime().ToString('O'))
if ($reused.ProcessId -contains 201) { throw 'A reused toolkit PID was accepted.' }
'PASS: shared process selection, child creation ordering and reused toolkit PID rejection'
