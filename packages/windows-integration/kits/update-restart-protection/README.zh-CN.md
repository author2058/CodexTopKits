# Update restart protection

[English](README.md) | 简体中文

保护 Codex 登记的重启参数，使 Toolkit 在 Codex 官方更新重启后继续保持连接。

安装 PowerShell 7。在 Kit 运行时的 `options.services` 中，将 `restart-protection.module` 设置为 `codex-toolkit-windows/restart-protection-service`。需要时通过 `restart-protection.options.powershellPath` 指定 PowerShell 7 可执行文件路径。在 **插件** 中启用 `update-restart-protection`，然后选择 **重启插件宿主**。

有更新时可使用 Codex 的更新按钮。按钮上的绿点表示重启保护及登记参数已确认。保护报告错误时，可在管理页面查看详情；安全软件可能阻止此进程操作。已登记的保护会保留到 Codex 进程退出。

需要 Core 0.3.23 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
