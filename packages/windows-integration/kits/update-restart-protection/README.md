# Update restart protection

[English](#update-restart-protection) | [简体中文](#简体中文)

Keeps the Toolkit's connection available across the official Codex update restart by protecting the registered restart arguments.

## Use

Install PowerShell 7. In the Kit runtime's `options.services`, set `restart-protection.module` to `codex-toolkit-windows/restart-protection-service`. Set `restart-protection.options.powershellPath` to the PowerShell 7 executable path when needed. Enable `update-restart-protection` in **Kits** and select **Restart Kit host**.

Use the Codex update button when an update is available. A green dot on the button indicates that the restart protection and registered arguments have been verified. If protection reports an error, check the manager for details; security software may block the process operation. The registered protection remains active until the Codex process exits.

Requires Core 0.3.23 or later.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)

## 简体中文

保护 Codex 登记的重启参数，使 Toolkit 在 Codex 官方更新重启后继续保持连接。

安装 PowerShell 7。在 Kit 运行时的 `options.services` 中，将 `restart-protection.module` 设置为 `codex-toolkit-windows/restart-protection-service`。需要时通过 `restart-protection.options.powershellPath` 指定 PowerShell 7 可执行文件路径。在 **插件** 中启用 `update-restart-protection`，然后选择 **重启插件宿主**。

有更新时可使用 Codex 的更新按钮。按钮上的绿点表示重启保护及登记参数已确认。保护报告错误时，可在管理页面查看详情；安全软件可能阻止此进程操作。已登记的保护会保留到 Codex 进程退出。

需要 Core 0.3.23 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
