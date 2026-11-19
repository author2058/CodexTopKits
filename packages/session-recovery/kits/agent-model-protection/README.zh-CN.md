# Agent model protection

[English](README.md) | 简体中文

帮助明确登记的 v1 子代理聊天在卸载和恢复后保留模型、推理强度与服务等级。此 Kit 默认关闭，使用 Session Recovery 的登记表和发送准备流程。

### 使用

安装 `codex-toolkit-session` 和 Core 0.3.39 或更高版本。将 Session Recovery 放在 Kit 宿主之前，并将其 `externalKits` 选项设为 `["agent-model-protection"]`。在 Kit 宿主中将 `services.session-runtime.module` 配置为 `codex-toolkit-session/model-protection-service`，然后在 **插件** 中启用 `agent-model-protection` 并点击 **重启插件宿主**。

使用完整设置登记 v1 子代理，之后每次发送前通过准备命令取得发送路由。将下方占位符替换为已安装 CLI、Core 状态目录、子聊天和父聊天 ID 及所需设置：

```powershell
node '<installation>/node_modules/codex-toolkit-session/src/cli.mjs' register --state-directory '<Core state directory>' --thread-id '<child ID>' --parent-thread-id '<parent ID>' --model '<model>' --effort '<effort>' --service-tier '<tier>'
node '<installation>/node_modules/codex-toolkit-session/src/cli.mjs' prepare-send --state-directory '<Core state directory>' --thread-id '<child ID>'
```

`prepare-send` 会恢复并检查登记的设置，然后返回发送路由。要更改设置，请重新登记完整组合。停用 Kit 后保护登记仍然保留；受保护聊天的发送准备需要启用该 Kit。要结束保护，请使用同一 CLI 执行 `unprotect --state-directory '<Core state directory>' --thread-id '<child ID>'`；Session Recovery 会保留已登记设置和聊天。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
