# Message labels

[English](README.md) | 简体中文

消息标签为助手消息显示其在当前轮次中的序号和本地时间。序号按六种颜色循环，并为相关活动显示同色标线。

将 `chat-history` 服务的模块配置为 `codex-toolkit-chat/history-service`，在 **插件** 中启用 `message-labels`，再点击 **重启插件宿主**。服务读取本机 Codex 历史数据库，为部分加载的已完成轮次提供消息标识、序号和时间戳。使用自定义 Codex 目录时，可将服务的可选 `options.codexHome` 设置为该目录的绝对路径。此 Kit 需要 Core 0.3.23 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
