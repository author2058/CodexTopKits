# Window tabs

English | [简体中文](README.zh-CN.md)

Adds tabs for open Codex windows to the bottom toolbar. Each tab shows its window's title and indicates running or unread activity.

## Use

In the Kit runtime's `options.services`, set `windows.module` to `codex-toolkit-windows/feature-service`. The Windows service uses PowerShell 7; set `windows.options.powershellPath` to its executable path when needed. Enable `footer` and `window-tabs` in **Kits**, then select **Restart Kit host**.

Select a tab to bring its Codex window forward. A running indicator takes precedence over the unread indicator. Requires Core 0.3.39 or later and `footer` 0.1.3 or later in the 0.1 series.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
