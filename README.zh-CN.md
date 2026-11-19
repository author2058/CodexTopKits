# CodexTopKits

[English](README.md) | 简体中文

**CodexTopKits 是 Codex Desktop Toolkits 的简写。** 它为 Codex 桌面应用提供可独立选择的增强功能，包括工程配色、底部工具栏、对话指示、语音控制和图片流量工具。

CodexTopKits 通过 Chrome DevTools Protocol（CDP）在运行时向 Codex 桌面应用注入 JavaScript 和 CSS。

## 能做什么

- 为工程和聊天分配配色、调整界面字号，通过底栏切换已打开的窗口。
- 在对话旁查看周用量余量、上下文使用率、输出速度和运行时间。
- 查看模型实时输出、浏览长对话，让表格和文件引用更易阅读。
- 说话时自动降低语音播放音量，并可随时改为手动调节。
- 复用已上传的图片引用，按请求、聊天和采集来源查看流量。
- 工作时保持电脑唤醒，或在全部聊天空闲后预约睡眠。

## Kits 的特色

每个 Kit 都有独立版本、依赖和更新选择。按需启用功能、准备单个更新，再重启 Kit 宿主，Codex 和模型连接保持运行。Core 提供共用连接、生命周期和本地管理器；相关 Kits 按需共享服务。

管理器支持英语、简体中文，以及跟随 Codex 宿主的自动语言模式。第三方开发者可通过相同的[公开 Kit API](packages/core/docs/features.md)编写扩展。

## 开始使用

需要 **Windows x64**、**Codex 桌面应用**、带 npm 的 **Node.js 24 或更高版本**，以及 **PowerShell 7**。可通过 GitHub 的 **Code** 菜单克隆仓库或下载 ZIP。

1. 在仓库目录打开 PowerShell 7，安装锁定的依赖：

   ```powershell
   npm ci --ignore-scripts --no-audit --no-fund
   ```

2. 按[安装指南](docs/getting-started.zh-CN.md)构建前三个 Kits 并创建本地配置。示例启用底栏、设置按钮和表格样式。
3. 生成启动入口并打开管理器：

   ```powershell
   node state/local/node_modules/codex-toolkit-core/src/cli.mjs prepare ./state/local/toolkit.json
   ./state/local/open-manager.cmd
   ```

4. 正常退出 Codex，再打开 `state/local/start-toolkit.cmd`。在管理器的 **插件** 页选择功能；后续 Kit 变更通过 **重启插件宿主** 生效。

## 安全

CDP 注入存在安全风险：获得调试连接访问权的程序可能读取会话内容、修改界面或触发 Codex 中的操作。Kit 代码以当前用户的文件与网络权限运行，恶意或被篡改的代码可能泄露或修改本地文件，并向外发送数据。应从可信来源安装 Kits。相关设置与权限见[安装指南](docs/getting-started.zh-CN.md#设置与安全)。

## Kits

各链接指向对应 Kit 的具体用法。

### 底栏与桌面

- [footer](packages/core/kits/footer/README.zh-CN.md) — 添加分为左、中、右三个区域的底部工具栏。
- [manager-entry](packages/core/kits/manager-entry/README.zh-CN.md) — 从底栏打开设置并显示当前错误数量。
- [app-restart](packages/core/kits/app-restart/README.zh-CN.md) — 在 File 菜单添加带 20 秒确认倒计时的重启命令。
- [window-tabs](packages/windows-integration/kits/window-tabs/README.zh-CN.md) — 通过带聊天标题和活动状态的标签切换 Codex 窗口。
- [auto-sleep](packages/windows-integration/kits/auto-sleep/README.zh-CN.md) — 全部聊天空闲一分钟后，让电脑进入睡眠。
- [awake-bridge](packages/windows-integration/kits/awake-bridge/README.zh-CN.md) — 在 Codex 聊天运行期间保持 Windows 唤醒。
- [cloud-mark-read](packages/windows-integration/kits/cloud-mark-read/README.zh-CN.md) — 从底栏将云端任务通知标记为已读。
- [markdown-edge-read-aloud](packages/windows-integration/kits/markdown-edge-read-aloud/README.zh-CN.md) — 在 Microsoft Edge 中打开 Markdown 文件并朗读。
- [update-restart-protection](packages/windows-integration/kits/update-restart-protection/README.zh-CN.md) — 在应用更新重启时保留 Toolkit 启动参数，并以绿点显示接管状态。

### 对话

- [weekly-usage](packages/chat-enhancements/kits/weekly-usage/README.zh-CN.md) — 显示周用量余量、重置时间，以及可对照的用量与时间进度线。
- [scheduled-reset-marker](packages/chat-enhancements/kits/scheduled-reset-marker/README.zh-CN.md) — 将 Codex Resets 的预计重置时间叠加到余量时间线上。
- [context-meter](packages/chat-enhancements/kits/context-meter/README.zh-CN.md) — 在输入框内用细色条显示上下文使用率。
- [output-speed](packages/chat-enhancements/kits/output-speed/README.zh-CN.md) — 在输出区域下沿附近显示请求计时和 token 速率。
- [composer-timer](packages/chat-enhancements/kits/composer-timer/README.zh-CN.md) — 在输入框下方的动态状态条中显示本轮运行时间。
- [live-model-output](packages/chat-enhancements/kits/live-model-output/README.zh-CN.md) — 点击运行状态条，打开紧凑的模型实时文字面板。
- [message-labels](packages/chat-enhancements/kits/message-labels/README.zh-CN.md) — 为输出添加回合内序号、时间和对应的彩色竖线。
- [history-show-all](packages/chat-enhancements/kits/history-show-all/README.zh-CN.md) — 在展开的回合过程加载不完整时显示全部历史。
- [title-emoji](packages/chat-enhancements/kits/title-emoji/README.zh-CN.md) — 将聊天标题中的第一个 emoji 显示为淡淡的背景装饰。
- [fast-mode-indicator](packages/chat-enhancements/kits/fast-mode-indicator/README.zh-CN.md) — 当前输入框使用快速模式时显示闪电装饰。
- [child-model-warning](packages/chat-enhancements/kits/child-model-warning/README.zh-CN.md) — 子代理或旁聊天的模型、思考等级与父聊天相同时，高亮其输入框。
- [table-style](packages/chat-enhancements/kits/table-style/README.zh-CN.md) — 让表格字号与正文一致，并添加内部单元格边框。
- [image-viewer-close](packages/chat-enhancements/kits/image-viewer-close/README.zh-CN.md) — 将图片查看浮层的关闭按钮改为醒目的红色。
- [selection-actions-delay](packages/chat-enhancements/kits/selection-actions-delay/README.zh-CN.md) — 延迟显示选中文字的操作栏，淡入完成后再允许点击。
- [file-line-highlight](packages/chat-enhancements/kits/file-line-highlight/README.zh-CN.md) — 文件在右栏打开时，短暂高亮链接所指的行。
- [rich-paste-boundary](packages/chat-enhancements/kits/rich-paste-boundary/README.zh-CN.md) — 修正输入框富文本粘贴边界多出的空白。
- [scroll-handoff-fix](packages/chat-enhancements/kits/scroll-handoff-fix/README.zh-CN.md) — 稳定回合开始和结束时的聊天滚动位置。
- [scroll-diagnostics](packages/chat-enhancements/kits/scroll-diagnostics/README.zh-CN.md) — 记录滚动变化，帮助分析异常跳动。

### 外观

- [project-thread-colors](packages/themes/kits/project-thread-colors/README.zh-CN.md) — 为工程和聊天分配配色，支持继承和全局区域开关。
- [ui-font-size](packages/themes/kits/ui-font-size/README.zh-CN.md) — 在主题管理器中设置界面字号覆盖值。
- [profile-panel-shadow](packages/themes/kits/profile-panel-shadow/README.zh-CN.md) — 让个人菜单与侧栏背景更易区分。

### 语音与会话工具

- [voice-volume](packages/voice-controls/kits/voice-volume/README.zh-CN.md) — 说话时自动降低播放音量，并提供手动音量滑杆。
- [agent-composer](packages/session-recovery/kits/agent-composer/README.zh-CN.md) — 在受支持的只读子代理面板中恢复可交互输入框。
- [agent-model-protection](packages/session-recovery/kits/agent-model-protection/README.zh-CN.md) — 在受保护发送前恢复已登记 v1 子代理的模型、思考等级和速度设置。
- [context-recovery-integration](packages/session-recovery/kits/context-recovery-integration/README.zh-CN.md) — 为 Codex 聊天安装有界的压缩后恢复流程。

### 图片带宽与流量

- [image-policy-rules](packages/traffic/kits/image-policy-rules/README.zh-CN.md) — 安装图片格式指导和格式检查 Hook，改善模型识图的传输效率。
- [image-reference-dedup](packages/traffic/kits/image-reference-dedup/README.zh-CN.md) — 在模型请求之间复用按图片内容识别的已上传引用。
- [traffic-observer](packages/traffic/kits/traffic-observer/README.zh-CN.md) — 为本地带宽面板采集流量元数据。

## 帮助与参与

可在本仓库的 Issues 页提出问题或报告故障。请附上相关 Kit 版本、Codex 版本、预期行为和复现步骤；需要时提供已脱敏的诊断信息。

开发新 Kit 或集成时，可从 [Kit API 与打包指南](packages/core/docs/features.md)开始。Kits 可以使用独立仓库、版本和发布工件。

## 许可证

CodexTopKits 使用 [Apache License 2.0](LICENSE)。归属信息见 [NOTICE](NOTICE)，依赖的各自许可证见[第三方依赖说明](packages/traffic/THIRD-PARTY.md)。
