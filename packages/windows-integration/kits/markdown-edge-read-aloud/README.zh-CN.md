# Markdown read aloud

[English](README.md) | 简体中文

从 Codex 将 Markdown 文件交给 Microsoft Edge 打开，并启动 Edge 的朗读功能。

安装 Microsoft Edge 和 PowerShell 7。在 Kit 运行时的 `options.services` 中，将 `read-aloud.module` 设置为 `codex-toolkit-windows/read-aloud-service`；需要时通过 `read-aloud.options.powershellPath` 指定 PowerShell 7 可执行文件路径。在 **插件** 中启用 `markdown-edge-read-aloud`，然后选择 **重启插件宿主**。

右键点击会话中的 `.md` 文件链接或文件树中的 Markdown 文件，选择 **用 Microsoft Edge 打开并朗读**。Edge 会切换到前台，以 200% 缩放打开文件并开始朗读。此操作会切换前台窗口；如果无法切换到 Edge 或确认播放，可在管理页面查看详情。

需要 Core 0.3.39 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
