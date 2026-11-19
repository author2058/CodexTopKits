# Awake bridge

English | [简体中文](README.zh-CN.md)

Keeps Windows awake while Codex conversations run and releases that state as activity finishes.

## Use

Install Windows Integration 0.2.22 or later and PowerShell 7. In the Kit runtime's `options.services`, set `windows.module` to `codex-toolkit-windows/feature-service` and `awake.module` to `codex-toolkit-windows/awake-service` (Awake service API 1.1.0 or later). Set either service's `options.powershellPath` to the PowerShell 7 executable path when needed. By default, the Kit stores its activity state in the Toolkit's private state directory. Disabling the Kit releases this installation's keep-awake state. To use an existing Awake script, set `awake.options.awakeScript` to its absolute path.

Enable `awake-bridge` in **Kits** and select **Restart Kit host**. The bridge forwards turn start and completion events and checks loaded conversation activity every 30 seconds while a Codex window is available. Requires Core 0.3.23 or later.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
