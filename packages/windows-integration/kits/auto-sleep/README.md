# Scheduled sleep

English | [简体中文](README.zh-CN.md)

Adds a moon button that schedules Windows sleep after Codex conversations finish.

## Use

In the Kit runtime's `options.services`, set `windows.module` to `codex-toolkit-windows/feature-service`. The Windows service uses PowerShell 7; set `windows.options.powershellPath` to its executable path when needed. Enable `footer` and `auto-sleep` in **Kits**, then select **Restart Kit host**.

Select the moon in the bottom toolbar to arm sleep. After all local conversations finish and remain idle for one minute, the Kit checks their current activity and requests Windows sleep when none are running. New activity postpones the request. Select the moon again to cancel. The same setting is shown in each Codex window, and sleep or resume turns it off; select the moon again to schedule another sleep.

The moon is dim when off and bright when armed. If an error occurs, check the manager for details. Requires Core 0.3.39 or later and `footer` 0.1.1 or later in the 0.1 series.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
