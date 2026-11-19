# Voice volume

English | [简体中文](README.zh-CN.md)

Adds playback volume controls below the voice orb during a Codex voice call. **Auto** is selected by default: after microphone sound continues for 200 ms, playback falls to one tenth of its native volume, stays lowered for 3 seconds after sound stops, and then recovers smoothly. Drag the slider for manual volume; select **Auto** again to restore ducking.

Enable `voice-volume` in **Kits** and choose **Restart Kit host**. Core 0.3.39 or later is required. With Voice Controls installed, set its `externalKit` option to `true` and place the module before the Kit runtime. The Kit uses the call's existing microphone stream and playback object; it adjusts voice playback volume. Finish an active voice call before restarting the Kit host.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
