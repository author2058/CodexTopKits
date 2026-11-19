# CodexTopKits — Voice controls

English | [简体中文](README.zh-CN.md)

Voice controls adjusts local playback volume during native Codex voice calls. It requires [Core](../core/README.md) 0.3.5 or a compatible later version and can be installed independently. The package imports as `codex-toolkit-voice` and is licensed under [Apache-2.0](LICENSE).

See the [installation guide](../../docs/getting-started.md) and [voice-volume Kit](kits/voice-volume/README.md).

## Behavior

A volume slider and an initially selected **Auto** checkbox appear below the voice orb. In Auto mode, microphone activity lasting 200 ms lowers assistant playback to one tenth of its native volume. The lower volume is held for 3 seconds after activity stops, then recovers smoothly. Sounds shorter than 200 ms neither trigger nor extend ducking.

Dragging the slider immediately switches to manual volume. Select **Auto** again to resume ducking. The playback window and the window containing the orb synchronize through a local page channel; system volume and other applications keep their own levels.

The component reuses the current native call's microphone stream and playback object. Audio, samples and transcripts stay out of its recordings and network traffic. Cloud generation continues while local playback is quieter; the stream keeps playing rather than buffering suppressed audio for later.

## Install and configure

Requires Windows x64, Node.js 24, PowerShell 7 and Codex. Install compatible Core and Voice controls packages, then add this entry to the existing `toolkit.json`, preserving other component settings:

```json
{ "module": "codex-toolkit-voice", "options": { "cdpPort": "auto" } }
```

Use Core to generate launch entries. Fully exit Codex and open it through the generated entry; controls become active on the next native voice call. Core shares the local CDP port and browser connection with other components that need them.

Open **Voice volume** in the Core manager to inspect interface status and specific errors. **Recheck** retries failed interfaces and preserves the controls during a call. End the call before retrying an incompatible interface.

CDP grants broad application access and has no password authentication. Use it in a trusted local environment. Component code runs with the current user's permissions.

## Upgrade and disable

Exit Codex, stop Core, upgrade the component and start through the same entry. To disable it, remove the component from the Core configuration. Normal unloading closes its listeners and page channels and restores the native playback volume it held. System volume, voice content and other components' configuration are preserved.
