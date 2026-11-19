#Requires -Version 7.0
. (Join-Path $PSScriptRoot 'localization.ps1')
function Confirm-CodexRestart {
    param([scriptblock]$OnShown = {}, [scriptblock]$IsCancelled = { $false }, [string]$Locale)
    $CodexLocale = if ($Locale) { $Locale } else { Get-CodexLocale }
    Add-Type -AssemblyName System.Windows.Forms
    if (-not ('System.Windows.Forms.TaskDialog' -as [type])) { throw (Get-CodexText 'Restart confirmation requires a current PowerShell 7 installation. Update PowerShell and try again.' '重启确认需要较新的 PowerShell 7。请更新 PowerShell 后重试。') }
    [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::ThrowException)
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $chinese = $CodexLocale -eq 'zh-Hans'
    $heading = if ($chinese) { 'Codex 将在 {0} 秒后重启' } else { 'Codex will restart in {0} seconds' }
    $page = [System.Windows.Forms.TaskDialogPage]::new()
    $page.Caption = 'CodexTopKits'
    $page.Heading = $heading -f 20
    $page.Text = if ($chinese) { 'Codex 将关闭并通过 CodexTopKits 重新打开。选择“取消”可保持应用打开。' } else { 'Codex will close and reopen with CodexTopKits. Choose Cancel to keep the application open.' }
    $page.AllowCancel = $true
    $restart = [System.Windows.Forms.TaskDialogButton]::new($(if ($chinese) { '立即重启' } else { 'Restart now' }), $true, $true)
    $cancel = [System.Windows.Forms.TaskDialogButton]::new($(if ($chinese) { '取消' } else { 'Cancel' }), $true, $true)
    $page.Buttons.Add($restart)
    $page.Buttons.Add($cancel)
    $page.DefaultButton = $cancel
    $watch = [Diagnostics.Stopwatch]::new()
    $state = @{ timedOut = $false; seconds = 20; failure = $null }
    $timer = [System.Windows.Forms.Timer]::new()
    $timer.Interval = 200
    $timer.add_Tick({
        try {
            if (& $IsCancelled) { $page.BoundDialog.Close(); return }
            $remaining = [Math]::Max(0, [int][Math]::Ceiling(20 - $watch.Elapsed.TotalSeconds))
            if ($remaining -ne $state.seconds) { $state.seconds = $remaining; $page.Heading = $heading -f $remaining }
            if ($remaining -eq 0) { $state.timedOut = $true; $restart.PerformClick() }
        } catch {
            $state.failure = $_
            $page.BoundDialog.Close()
        }
    })
    $page.add_Created({
        try {
            $watch.Start()
            $timer.Start()
            $null = & $OnShown $page $restart $cancel
        } catch {
            $state.failure = $_
            $page.BoundDialog.Close()
        }
    })
    try {
        $selected = [System.Windows.Forms.TaskDialog]::ShowDialog($page, [System.Windows.Forms.TaskDialogStartupLocation]::CenterScreen)
        if ($state.failure) { throw $state.failure }
        $decision = if ($selected -ne $restart) { 'cancelled' } elseif ($state.timedOut) { 'timeout' } else { 'restart-now' }
        return [pscustomobject]@{ decision = $decision; elapsedMs = $watch.ElapsedMilliseconds }
    } catch {
        # Native dialog callbacks can replace an escaping exception with an opaque SEHException.
        if ($state.failure) { throw $state.failure }
        throw
    } finally {
        $timer.Stop()
        $timer.Dispose()
        $watch.Stop()
    }
}
