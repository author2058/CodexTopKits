# Voice volume

[English](README.md) | 简体中文

在 Codex 语音通话的圆球下方添加播放音量控制。默认选中 **自动**：麦克风声音持续 200 毫秒后，播放音量降至原生音量的十分之一；声音停止后保持 3 秒，再平滑恢复。拖动滑杆切换到手动音量；再次选中 **自动** 可恢复自动压低。

在 **插件** 中启用 `voice-volume`，再点击 **重启插件宿主**。需要 Core 0.3.39 或更高版本。安装 Voice Controls 时，将其 `externalKit` 选项设为 `true`，并将该模块放在 Kit 宿主之前。Kit 使用通话已有的麦克风流和播放对象，调整语音播放音量；重启插件宿主前请先结束正在进行的语音通话。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
