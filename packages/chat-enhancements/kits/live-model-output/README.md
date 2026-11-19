# Live model output

[English](#live-model-output) | [简体中文](#简体中文)

Shows the latest 50 lines of observed model output for the current chat, including model-authored text and tool inputs.

## Use

Enable `live-model-output` and its [composer timer](../composer-timer/README.md) dependency in **Kits**, then choose **Restart Kit host**. During a turn, click the timer bar below the composer to show or hide the output panel. The panel continues collecting observed output while closed, clears at the start of a new turn and closes when the turn finishes.

The panel covers output observed while the Kit and window are active. Requires Core 0.3.39 or later and `composer-timer` 0.1.0 or later within the 0.1 series; the timer also requires the `chat-diagnostics` service.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)

## 简体中文

显示当前聊天中已观测到的最新 50 行模型输出，包括模型生成的文字和工具输入。

在 **插件** 中启用 `live-model-output` 和依赖的[输入框计时器](../composer-timer/README.md#简体中文)，再点击 **重启插件宿主**。本轮进行时，点击输入框下方的计时条可展开或关闭输出面板。面板关闭时仍会收集观测到的输出；新一轮开始时清空，并在本轮结束时关闭。

面板显示 Kit 和窗口处于活动状态时观测到的输出。需要 Core 0.3.39 或更高版本，以及 0.1 系列中 0.1.0 或更高版本的 `composer-timer`；计时器还需要 `chat-diagnostics` 服务。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
