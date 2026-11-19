# Window tabs

[English](#window-tabs) | [简体中文](#简体中文)

Adds tabs for open Codex windows to the bottom toolbar. Each tab shows its window's title and indicates running or unread activity.

## Use

In the Kit runtime's `options.services`, set `windows.module` to `codex-toolkit-windows/feature-service`. The Windows service uses PowerShell 7; set `windows.options.powershellPath` to its executable path when needed. Enable `footer` and `window-tabs` in **Kits**, then select **Restart Kit host**.

Select a tab to bring its Codex window forward. A running indicator takes precedence over the unread indicator. Requires Core 0.3.39 or later and `footer` 0.1.3 or later in the 0.1 series.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)

## 简体中文

在底部工具栏显示已打开的 Codex 窗口标签。每个标签显示窗口标题，以及运行中或未读状态。

在 Kit 运行时的 `options.services` 中，将 `windows.module` 设置为 `codex-toolkit-windows/feature-service`。Windows 服务使用 PowerShell 7；需要时可通过 `windows.options.powershellPath` 指定其可执行文件路径。在 **插件** 中启用 `footer` 和 `window-tabs`，再选择 **重启插件宿主**。

点击标签可切换到对应的 Codex 窗口。运行中标记优先于未读标记显示。需要 Core 0.3.39 或更高版本，以及 `footer` 0.1 系列中的 0.1.3 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
