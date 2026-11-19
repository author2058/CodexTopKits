# Scroll diagnostics

[English](README.md) | 简体中文

记录滚动操作和布局信息，帮助排查聊天阅读位置意外变化的问题。记录可能包含聊天和轮次标识、滚动位置、布局尺寸及调用栈；分享前请先检查记录内容。

将 `chat-diagnostics` 服务的模块配置为 `codex-toolkit-chat/diagnostic-service`。在 **插件** 中启用 `scroll-diagnostics`，再点击 **重启插件宿主**。该服务将诊断记录写入 Toolkit 日志。需要 Core 0.3.23 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
