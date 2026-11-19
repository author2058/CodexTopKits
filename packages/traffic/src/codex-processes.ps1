function Select-CodexTrafficProcesses {
    param([object[]]$Processes, [int]$ToolkitProcessId = 0, [string]$ToolkitCreatedAt = '')
    $selected = @{}
    foreach ($item in $Processes) {
        $app = $item.Name -eq 'ChatGPT.exe' -and $item.ExecutablePath -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$'
        $native = $item.Name -eq 'codex.exe' -and $item.ExecutablePath -match '\\(OpenAI\\Codex\\bin\\|OpenAI\.Codex_[^\\]+\\app\\)'
        $toolkit = $ToolkitProcessId -gt 0 -and $item.ProcessId -eq $ToolkitProcessId -and $item.Name -eq 'node.exe' -and
            (-not $ToolkitCreatedAt -or $item.CreationDate.ToUniversalTime().ToString('O') -ceq $ToolkitCreatedAt)
        if ($app -or $native -or $toolkit) { $selected[[int]$item.ProcessId] = $item }
    }
    do {
        $added = $false
        foreach ($item in $Processes) {
            if ($item.ProcessId -ne $PID -and -not $selected.ContainsKey([int]$item.ProcessId) -and $selected.ContainsKey([int]$item.ParentProcessId) -and $item.CreationDate -ge $selected[[int]$item.ParentProcessId].CreationDate) {
                $selected[[int]$item.ProcessId] = $item
                $added = $true
            }
        }
    } while ($added)
    return @($selected.Values)
}

function Get-CodexTrafficProcesses {
    param([int]$ToolkitProcessId = 0, [string]$ToolkitCreatedAt = '')
    $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate)
    Select-CodexTrafficProcesses -Processes $all -ToolkitProcessId $ToolkitProcessId -ToolkitCreatedAt $ToolkitCreatedAt
}
