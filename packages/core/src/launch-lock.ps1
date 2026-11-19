#Requires -Version 7.0
. (Join-Path $PSScriptRoot 'localization.ps1')
function Invoke-SerializedCodexLaunch {
    param([string]$Key, [string]$ReceiptPath, [scriptblock]$Launch, [scriptblock]$Verify, [string]$PreviousLaunchId)
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $mutex = [Threading.Mutex]::new($false, ('Local\CodexTopKits-Launch-' + $Key))
    $locked = $false
    try {
        $locked = $mutex.WaitOne(0)
        if ($locked -and $PreviousLaunchId -and (Test-Path -LiteralPath $ReceiptPath)) {
            $previous = [IO.File]::ReadAllText($ReceiptPath, $utf8) | ConvertFrom-Json -AsHashtable
            if ($previous.stage -eq 'completed' -and $previous.id -cne $PreviousLaunchId) { & $Verify $previous.result; return $previous.result }
        }
        if (-not $locked) {
            Write-Host (Get-CodexText 'Another launcher is opening Codex. Waiting for its result…' '另一个启动器正在打开 Codex，正在等待结果…')
            while (-not ($locked = $mutex.WaitOne(250))) {}
            $receipt = [IO.File]::ReadAllText($ReceiptPath, $utf8) | ConvertFrom-Json -AsHashtable
            if ($receipt.stage -ne 'completed') { throw ((Get-CodexText 'The other launch failed: ' '另一个启动操作失败：') + $receipt.error.detail) }
            & $Verify $receipt.result
            return $receipt.result
        }
        $id = [guid]::NewGuid().ToString('N')
        try {
            $result = & $Launch
            & $Verify $result
            $receipt = @{ stage = 'completed'; id = $id; at = [DateTimeOffset]::Now.ToString('o'); result = $result }
        } catch {
            $receipt = @{ stage = 'error'; id = $id; at = [DateTimeOffset]::Now.ToString('o'); error = @{ type = $_.Exception.GetType().FullName; message = $_.Exception.Message; detail = ($_ | Out-String) } }
            throw
        } finally {
            if ($receipt) {
                $temporary = $ReceiptPath + '.' + $id + '.tmp'
                [IO.File]::WriteAllText($temporary, ($receipt | ConvertTo-Json -Depth 12), $utf8)
                [IO.File]::Move($temporary, $ReceiptPath, $true)
            }
        }
        return $result
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
