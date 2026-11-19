# Scheduled sleep

[English](README.md) | 简体中文

在底部工具栏添加月亮按钮，用于在 Codex 会话结束后预约 Windows 睡眠。

在 Kit 运行时的 `options.services` 中，将 `windows.module` 设置为 `codex-toolkit-windows/feature-service`。Windows 服务使用 PowerShell 7；需要时可通过 `windows.options.powershellPath` 指定其可执行文件路径。在 **插件** 中启用 `footer` 和 `auto-sleep`，再选择 **重启插件宿主**。

点击底栏的月亮预约睡眠。全部本地会话结束并静置一分钟后，Kit 会检查当前会话活动，确认没有会话运行时请求 Windows 睡眠。新的活动会推迟睡眠请求。再次点击月亮可取消预约。所有 Codex 窗口显示同一开关状态；系统睡眠或唤醒后开关会关闭，如需再次预约请重新点击月亮。

月亮变暗表示关闭，点亮表示已预约。出现错误时，可在管理页面查看详情。需要 Core 0.3.39 或更高版本，以及 `footer` 0.1 系列中的 0.1.1 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
