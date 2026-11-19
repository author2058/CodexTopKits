# CodexTopKits

English | [简体中文](README.zh-CN.md)

**CodexTopKits is short for Codex Desktop Toolkits.** It adds individually selectable enhancements to the Codex desktop app: workspace colors, a useful bottom toolbar, conversation indicators, voice controls and image bandwidth tools.

CodexTopKits uses the Chrome DevTools Protocol (CDP) to inject JavaScript and CSS into the Codex desktop app at runtime.

## What you can do

- Give projects and chats their own colors, adjust UI text size and switch between open windows from the toolbar.
- See weekly allowance, context usage, response speed and elapsed time alongside a conversation.
- Read live model output, navigate long conversations and make tables and file references easier to read.
- Reduce voice playback volume while speaking, then adjust it manually whenever needed.
- Reuse uploaded image references and inspect traffic by request, chat and collection source.
- Keep the computer awake during work or schedule sleep after all chats become idle.

## Why Kits

Each Kit has its own version, dependencies and update selection. Choose the features to run, prepare an individual update and restart the Kit host while Codex and its model connection stay open. Core supplies the shared connection, lifecycle and local manager; related Kits share services where needed.

The manager supports English and Simplified Chinese, with an automatic language mode that follows the Codex host. Third-party authors can build Kits against the same [public Kit API](packages/core/docs/features.md).

## Get started

Requirements: **Windows x64**, the **Codex desktop app**, **Node.js 24 or later** with npm, and **PowerShell 7**. GitHub's **Code** menu offers the repository's clone and ZIP download options.

1. Open PowerShell 7 in the checked-out repository and install the locked dependencies:

   ```powershell
   npm ci --ignore-scripts --no-audit --no-fund
   ```

2. Follow the [installation guide](docs/getting-started.md) to build the first three Kits and create a local configuration. The example enables the footer, settings button and table styling.
3. Generate the launch entries and open the manager:

   ```powershell
   node state/local/node_modules/codex-toolkit-core/src/cli.mjs prepare ./state/local/toolkit.json
   ./state/local/open-manager.cmd
   ```

4. Quit Codex normally, then open `state/local/start-toolkit.cmd`. Open **Kits** in the manager to select features; apply later Kit changes with **Restart Kit host**.

## Security

CDP injection carries security risks. Software with access to the debugging connection could read conversations, modify the interface or trigger actions in Codex. Kit code runs with the current user's file and network permissions; malicious or tampered code could expose or modify local files and transmit data. Install Kits from trusted sources. See the [installation guide](docs/getting-started.md#settings-and-safety) for settings and permissions.

## Kits

Each link opens the Kit's own usage instructions.

### Toolbar and desktop

- [footer](packages/core/kits/footer/README.md) — Adds a bottom toolbar with left, flexible center and right areas.
- [manager-entry](packages/core/kits/manager-entry/README.md) — Opens settings from the toolbar and displays the current error count.
- [app-restart](packages/core/kits/app-restart/README.md) — Adds a File-menu restart command with a 20-second confirmation countdown.
- [window-tabs](packages/windows-integration/kits/window-tabs/README.md) — Switches between Codex windows using chat-title tabs and activity indicators.
- [auto-sleep](packages/windows-integration/kits/auto-sleep/README.md) — Schedules computer sleep after all chats have remained idle for a minute.
- [awake-bridge](packages/windows-integration/kits/awake-bridge/README.md) — Keeps Windows awake while Codex chats are working.
- [cloud-mark-read](packages/windows-integration/kits/cloud-mark-read/README.md) — Marks cloud task notifications as read from the toolbar.
- [markdown-edge-read-aloud](packages/windows-integration/kits/markdown-edge-read-aloud/README.md) — Opens Markdown files in Microsoft Edge for Read aloud.
- [update-restart-protection](packages/windows-integration/kits/update-restart-protection/README.md) — Preserves Toolkit launch arguments through the app's update restart and shows a green readiness dot.

### Conversations

- [weekly-usage](packages/chat-enhancements/kits/weekly-usage/README.md) — Shows weekly allowance, reset time and comparable usage/time progress bars.
- [scheduled-reset-marker](packages/chat-enhancements/kits/scheduled-reset-marker/README.md) — Overlays the Codex Resets forecast on the allowance timeline.
- [context-meter](packages/chat-enhancements/kits/context-meter/README.md) — Shows context consumption as a thin, color-coded bar inside the composer.
- [output-speed](packages/chat-enhancements/kits/output-speed/README.md) — Displays request timing and token-rate measurements near the output area's lower edge.
- [composer-timer](packages/chat-enhancements/kits/composer-timer/README.md) — Shows elapsed turn time in an animated activity bar below the composer.
- [live-model-output](packages/chat-enhancements/kits/live-model-output/README.md) — Opens a compact live text panel by clicking the activity bar.
- [message-labels](packages/chat-enhancements/kits/message-labels/README.md) — Adds turn-relative message numbers, timestamps and colored rails.
- [history-show-all](packages/chat-enhancements/kits/history-show-all/README.md) — Loads the complete process history when an expanded turn is partially loaded.
- [title-emoji](packages/chat-enhancements/kits/title-emoji/README.md) — Displays the first emoji in a chat title as a subtle background decoration.
- [fast-mode-indicator](packages/chat-enhancements/kits/fast-mode-indicator/README.md) — Shows a lightning decoration when the current composer uses Fast mode.
- [child-model-warning](packages/chat-enhancements/kits/child-model-warning/README.md) — Highlights a child or side-chat composer when its model and reasoning level match its parent.
- [table-style](packages/chat-enhancements/kits/table-style/README.md) — Matches table text to the reply font and adds internal cell borders.
- [image-viewer-close](packages/chat-enhancements/kits/image-viewer-close/README.md) — Makes the image viewer's close button bright red.
- [selection-actions-delay](packages/chat-enhancements/kits/selection-actions-delay/README.md) — Delays selection actions and fades them in before allowing clicks.
- [file-line-highlight](packages/chat-enhancements/kits/file-line-highlight/README.md) — Briefly highlights a referenced line when a file opens in the right-hand panel.
- [rich-paste-boundary](packages/chat-enhancements/kits/rich-paste-boundary/README.md) — Corrects extra whitespace at rich-text paste boundaries in the composer.
- [scroll-handoff-fix](packages/chat-enhancements/kits/scroll-handoff-fix/README.md) — Stabilizes conversation scroll position across turn transitions.
- [scroll-diagnostics](packages/chat-enhancements/kits/scroll-diagnostics/README.md) — Records scroll changes to help investigate unexpected jumps.

### Appearance

- [project-thread-colors](packages/themes/kits/project-thread-colors/README.md) — Assigns project and chat colors with inheritance and global surface controls.
- [ui-font-size](packages/themes/kits/ui-font-size/README.md) — Sets a UI font-size override from the theme manager.
- [profile-panel-shadow](packages/themes/kits/profile-panel-shadow/README.md) — Makes the profile menu easier to distinguish from the sidebar.

### Voice and session tools

- [voice-volume](packages/voice-controls/kits/voice-volume/README.md) — Ducks voice playback while speaking and provides a manual volume slider.
- [agent-composer](packages/session-recovery/kits/agent-composer/README.md) — Restores an interactive composer in supported read-only child-agent panels.
- [agent-model-protection](packages/session-recovery/kits/agent-model-protection/README.md) — Restores registered v1 child-agent model, reasoning and speed settings before protected sends.
- [context-recovery-integration](packages/session-recovery/kits/context-recovery-integration/README.md) — Installs a bounded post-compaction recovery workflow for Codex chats.

### Image bandwidth and traffic

- [image-policy-rules](packages/traffic/kits/image-policy-rules/README.md) — Installs image-format guidance and a format-check Hook for efficient model inspection.
- [image-reference-dedup](packages/traffic/kits/image-reference-dedup/README.md) — Reuses content-based uploaded image references across model requests.
- [traffic-observer](packages/traffic/kits/traffic-observer/README.md) — Collects traffic metadata for the local bandwidth dashboard.

## Help and contributing

Use this repository's Issues tab for questions and bug reports. Include the relevant Kit versions, Codex version, expected behavior and reproduction steps, together with sanitized diagnostics when useful.

For a new Kit or integration, start with the [Kit API and packaging guide](packages/core/docs/features.md). Kits can live in their own repositories and use independent versions and release artifacts.

## License

CodexTopKits is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution and [third-party dependencies](packages/traffic/THIRD-PARTY.md) for their respective licenses.
