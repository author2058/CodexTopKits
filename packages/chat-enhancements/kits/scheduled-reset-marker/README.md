# Scheduled reset marker

English | [简体中文](README.zh-CN.md)

Adds an estimated hard-reset marker to the [weekly usage](../weekly-usage/README.md) time track. The marker appears when Codex Resets provides a scheduled estimate within the current seven-day allowance period. Hover over it for the estimated time and click it to visit the source.

## Use

Configure the `scheduled-reset` service with module `codex-toolkit-chat/feature-service`. The service checks the public Codex Resets status every 10 minutes using PowerShell 7. It uses `pwsh.exe` by default; set the service option `powershellPath` to an absolute executable path when needed. Enable `scheduled-reset-marker` and its `weekly-usage` and `footer` dependencies in **Kits**, then choose **Restart Kit host**.

Requires Core 0.3.39 or later and `weekly-usage` 0.1.4 or later within the 0.1 series.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
