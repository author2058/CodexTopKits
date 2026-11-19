# Agent composer

[English](#agent-composer) | [简体中文](#简体中文)

Restores the interactive child-agent panel for a restored read-only v1 child chat. The Kit checks the native route and parent relationship before opening the panel.

Enable `agent-composer` in **Kits** and choose **Restart Kit host**. Core 0.3.39 or later is required. When using Session Recovery, set its `restoreAgentComposer` option to `false` and place Session Recovery before the Kit runtime. If a panel is being restored, wait for the operation to finish before restarting the Kit host.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)

## 简体中文

为恢复后处于只读状态的 v1 子代理聊天恢复交互式子代理面板。Kit 会先检查原生路由和父子关系，再打开面板。

在 **插件** 中启用 `agent-composer`，再点击 **重启插件宿主**。需要 Core 0.3.39 或更高版本。使用 Session Recovery 时，将其 `restoreAgentComposer` 选项设为 `false`，并将该模块放在 Kit 宿主之前。面板恢复期间，请等待恢复完成后再重启插件宿主。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
