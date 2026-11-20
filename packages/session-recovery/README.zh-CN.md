# CodexTopKits — SessionRecovery

[English](README.md) | 简体中文

SessionRecovery 为显式登记的 v1 子聊天提供可选保护，在 Codex 卸载或恢复聊天时保持其模型、思考等级和速度档位。当前 v2 工作流使用 Codex 原生设置恢复。可选的恢复规则帮助 Codex 在上下文压缩后找回当前断点，按边界读取所需内容。

组件依赖 [Core](../core/README.zh-CN.md) 0.3.5 或更高版本，使用 Core 已有的本机 CDP 连接、管理页和独立状态目录，保留 Codex 安装文件。

## 启用组件

同时安装 Core 与 SessionRecovery，然后将此条目添加到 Core 配置的 `plugins` 数组：

```json
{
  "module": "codex-toolkit-session",
  "options": { "cdpPort": "auto", "restoreAgentComposer": false, "externalKits": ["agent-model-protection"] }
}
```

通过 Toolkit 入口启动 Codex。在管理器中打开 **会话恢复**，查看受保护子聊天和恢复错误。保护仅针对主动登记的聊天。

`restoreAgentComposer` 可在恢复后使用 Codex 已有的可交互子聊天面板重新打开只读 v1 子代理。组件先核验原生路径和父子关系；接口变更或存在歧义时报告具体问题。适用范围是原生支持交互的 v1 路径。

## 按角色选择模型

可选的 [Role Model Selection Kit](kits/role-model-selection/README.zh-CN.md) 可为各聊天应用角色推荐的模型与思考档位。聊天默认不分配角色，选择角色后才应用推荐。Kit 支持编辑角色与推荐参数，默认优先选择占所选模型版本总请求数超过一半的档位，并保留聊天的服务档位和全局默认设置。

## 保护已有 v1 子聊天

先在 Kits 页启用可选的 `agent-model-protection`。从 Kit 0.1.3 和 Core 0.3.37 起，该 Kit 默认关闭，已有显式选择保持不变。SessionRecovery 遵循该开关；普通 v2 子代理使用原生恢复能力。

使用独立 Node 执行以下命令，填写实际安装 CLI 和 Core 状态目录的绝对路径：

```powershell
node '<installation>/node_modules/codex-toolkit-session/src/cli.mjs' register --state-directory '<Core state directory>' --thread-id '<child ID>' --parent-thread-id '<parent ID>' --model '<model>' --effort '<effort>' --service-tier '<tier>'
node '<installation>/node_modules/codex-toolkit-session/src/cli.mjs' prepare-send --state-directory '<Core state directory>' --thread-id '<target ID>'
```

登记时必须指定全部三项设置。`fast` 归一为 `priority`；`null` 表示显式清除思考等级或速度设置。`prepare-send` 在返回发送路径前恢复完整设置并读回核验：

- 受保护 v1 子聊天：`multi_agent_v1.send_input`。
- 普通同级聊天：`codex_app.send_message_to_thread`，保留其现有设置。

严格使用返回的路径。准备失败时停止发送。需要改变保护基线时，重新登记完整设置。原生通知可触发恢复，但已登记的基线保持不变。

`ensure` 只执行显式恢复与读回；`show` 查看当前组件状态。`register --no-ensure` 仅记录基线，原生设置的核验需另行完成。

结束某个目标的保护时，通过同一已安装 CLI 执行 `unprotect --state-directory '<Core state directory>' --thread-id '<child ID>'`。该命令保留记录的设置与聊天，结束自动保护，并让后续发送准备返回普通路径。仅关闭 Kit 会保留原有保护登记，相关发送会保持阻断，直到显式结束保护或重新启用 Kit。

若旧版活动 Kit 无法安全释放保护，命令会要求升级至 0.1.3 或更高版本，或先关闭 Kit。预检查失败时保留原登记。

本组件恢复已有聊天。调用方须先使用准备命令取得受支持的发送路径；创建 v1 子代理及原生工具可用性由 Codex 提供。

## 安装恢复技能与 Hook

明确填写 Codex home、Core 状态目录和已安装 PowerShell 7 的路径：

```powershell
node '<installation>/node_modules/codex-toolkit-session/src/cli.mjs' install-rules --codex-home '<Codex home>' --state-directory '<Core state directory>' --powershell '<PowerShell 7 executable>'
```

该命令安装 `context-recovery`、`codex-thread-runtime` 和仅在压缩时运行的 SessionStart Hook。运行时助手记录本安装的 Toolkit 状态目录。上下文助手按时间戳优先、有界读取本机 rollout 文件；文件内容留在本机。原生旁聊天跳过额外恢复。恢复错误保持可见，断点不确定时停止继续工作。

安装器保留其他 Hook 和 Codex 信任状态，遇到其他安装所属技能或本地修改时报告冲突。新增 Hook 由 Codex 执行原生信任确认。批准后，新建聊天；若当前客户端尚未重新加载技能或 Hook 配置，再重启 Codex。

`rules-status` 检查已安装文件。`remove-rules` 仅移除登记的文件和确切 Hook 分组，保留无关配置、信任状态、备份和保护设置。两者均接受相同的 `--codex-home` 和 `--state-directory` 参数。

## 数据与环境要求

需要 Node.js 24 或更高版本、Core 0.3.5 或更高版本。Windows 恢复 Hook 需要 PowerShell 7。设置与安装回执位于 Core 的 `plugins/session` 目录；技能和 Hook 位于显式选择的 Codex home。机器相关文件留在本机状态目录。

本包使用 [Apache-2.0](LICENSE)。
