#Requires -Version 7.0
param([Parameter(Mandatory)][string]$ConfirmationPath, [Parameter(Mandatory)][string]$Scenario)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
[cultureinfo]::CurrentUICulture = [cultureinfo]::GetCultureInfo('zh-CN')
. $ConfirmationPath
$observed = @{ shown = $false }
try {
    $result = Confirm-CodexRestart -IsCancelled { if ($Scenario -eq 'timer-error') { throw 'fixture-dialog-failure' }; $Scenario -eq 'external-cancel' } -OnShown {
        param($Page, $Restart, $Cancel)
        $observed.shown = $true
        $observed.heading = $Page.Heading
        $observed.restartLabel = $Restart.Text
        $observed.cancelLabel = $Cancel.Text
        if (-not $Page.AllowCancel -or $Page.DefaultButton -ne $Cancel) { throw 'Cancel must be the safe default and window closing must be allowed.' }
        $Page.Caption = 'CodexTopKits restart test — Codex stays open'
        $Page.Text = 'Test only. No application will be closed or restarted.'
        switch ($Scenario) {
            'restart-now' { $Restart.PerformClick() }
            'cancel' { $Cancel.PerformClick() }
            'close' { $Page.BoundDialog.Close() }
            'error' { throw 'fixture-dialog-failure' }
        }
    }
    $observed.decision = $result.decision
    $observed.elapsedMs = $result.elapsedMs
} catch {
    if ($Scenario -notin @('error', 'timer-error')) { throw }
    $observed.error = $_.Exception.ToString()
}
$observed | ConvertTo-Json -Compress
