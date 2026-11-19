# Scheduled reset marker

[English](README.md) | 简体中文

在[周用量](../weekly-usage/README.zh-CN.md)的时间进度条上添加预计硬重置标记。当 Codex Resets 提供的预计重置时间位于当前七天额度周期内时，标记会显示出来。将鼠标悬停在标记上可查看预计时间，点击标记可访问数据来源。

将 `scheduled-reset` 服务的模块配置为 `codex-toolkit-chat/feature-service`。该服务使用 PowerShell 7 每 10 分钟查询一次 Codex Resets 的公开状态。服务默认使用 `pwsh.exe`；需要时可通过服务选项 `powershellPath` 指定可执行文件的绝对路径。在 **插件** 中启用 `scheduled-reset-marker` 及其 `weekly-usage`、`footer` 依赖，再点击 **重启插件宿主**。

需要 Core 0.3.39 或更高版本，以及 0.1 系列中 0.1.4 或更高版本的 `weekly-usage`。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
