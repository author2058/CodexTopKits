# Output speed

[English](#output-speed) | [简体中文](#简体中文)

Displays generation speed, end-to-end speed and time to first response for observed model responses in the main chat, side chats and agent panels. Speeds use the response's native output token count: generation covers the interval between the first and last model content, while end-to-end speed includes request wait time.

## Use

Enable `output-speed` in **Kits**, then choose **Restart Kit host**. The latest measurements remain visible while browsing the conversation. During a new measurement, the previous values display with `...`; unavailable values display as `—`. Measurements cover responses observed while the Kit and window are active.

Requires Core 0.3.39 or later.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)

## 简体中文

在主聊天、侧边聊天和代理面板中显示已观测模型响应的生成速度、端到端速度和首响时间。速度使用该响应的原生输出 token 数计算：生成速度覆盖模型首末内容之间的时间，端到端速度还包含请求等待时间。

在 **插件** 中启用 `output-speed`，再点击 **重启插件宿主**。浏览聊天记录时，最近一次测量结果会保持显示。新测量进行期间，之前的数值后会显示 `...`；无法取得的数值显示为 `—`。测量范围为 Kit 和窗口处于活动状态时观测到的响应。

需要 Core 0.3.39 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
