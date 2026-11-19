# Voice volume

[English](#voice-volume) | [简体中文](#简体中文)

Adds playback volume controls below the voice orb during a Codex voice call. **Auto** is selected by default: after microphone sound continues for 200 ms, playback falls to one tenth of its native volume, stays lowered for 3 seconds after sound stops, and then recovers smoothly. Drag the slider for manual volume; select **Auto** again to restore ducking.

Enable `voice-volume` in **Kits** and choose **Restart Kit host**. Core 0.3.39 or later is required. With Voice Controls installed, set its `externalKit` option to `true` and place the module before the Kit runtime. The Kit uses the call's existing microphone stream and playback object; it adjusts voice playback volume. Finish an active voice call before restarting the Kit host.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)

## 简体中文

在 Codex 语音通话的圆球下方添加播放音量控制。默认选中 **自动**：麦克风声音持续 200 毫秒后，播放音量降至原生音量的十分之一；声音停止后保持 3 秒，再平滑恢复。拖动滑杆切换到手动音量；再次选中 **自动** 可恢复自动压低。

在 **插件** 中启用 `voice-volume`，再点击 **重启插件宿主**。需要 Core 0.3.39 或更高版本。安装 Voice Controls 时，将其 `externalKit` 选项设为 `true`，并将该模块放在 Kit 宿主之前。Kit 使用通话已有的麦克风流和播放对象，调整语音播放音量；重启插件宿主前请先结束正在进行的语音通话。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
