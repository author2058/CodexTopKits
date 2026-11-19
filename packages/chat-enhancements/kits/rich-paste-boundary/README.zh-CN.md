# Rich paste boundary

[English](README.md) | 简体中文

粘贴富文本时保留格式和链接：当纯文本内容与 HTML 内容一致且纯文本首尾没有空白时，清除 HTML 首尾多余的空白。

将 `chat-diagnostics` 服务的模块配置为 `codex-toolkit-chat/diagnostic-service`。在 **插件** 中启用 `rich-paste-boundary`，再点击 **重启插件宿主**。向输入框粘贴符合条件的富文本时，Kit 会自动处理。该服务记录粘贴内容长度和诊断原因。

需要 Core 0.3.23 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
