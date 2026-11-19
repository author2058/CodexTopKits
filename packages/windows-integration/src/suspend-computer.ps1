param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if ($ValidateOnly) {
    if (-not [System.Windows.Forms.Application].GetMethod('SetSuspendState')) { throw 'SetSuspendState is unavailable.' }
    Write-Output 'Sleep API validated without invoking suspend.'
    exit 0
}
if (-not [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)) {
    throw 'Windows rejected the suspend request.'
}
