# CodexTopKits — Chat enhancements

English | [简体中文](README.zh-CN.md)

Chat enhancements add conversation indicators, navigation and presentation features to Codex. The package imports as `codex-toolkit-chat` and requires [Core](../core/README.md) 0.3.16 or a compatible later version. It can be installed independently; when used with Themes, its toolbar follows the sidebar color.

The package is licensed under [Apache-2.0](LICENSE). See the [installation guide](../../docs/getting-started.md) and individual [conversation Kits](../../README.md#conversations).

## Features

- The toolbar shows native weekly usage, reset time and usage/time progress. It follows native cache changes rather than polling the usage endpoint. Its settings button opens the shared Core manager and displays the current issue count.
- Main chats, side chats and children with no composer have a speed label fixed near the output area's lower edge. It retains the last valid result and adds `...` during a pending measurement. Rates use exact native token counts paired with the request, first-response and last-response timestamps for that response; tool execution is kept separate from another response.
- Assistant messages have per-turn numbers, timestamps and six-color vertical lines placed outside the native layout. Loaded history is matched by native identity; partially loaded turns obtain their numbering and timestamps from the local history database.
- **Show all** appears when an expanded turn has more history to load and uses the native interface to fetch the remainder. History is loaded on demand.
- A context-usage line appears at the top of the composer. Predicted text is distinguished from actual input; compaction turns the line gray and stops flashing.
- A running-time bar below the composer retains the final duration. Click it for a compact live model-output panel containing observed model text, tool inputs and edits, keeping the latest 50 lines. Tool results, protocol wrappers and unavailable internal reasoning are excluded; collection covers periods when the window is rendering.
- Tables use consistent font sizing and internal borders; image viewers have a prominent close button, and file-line links briefly highlight the destination.
- The first title emoji appears above the composer, with a lightning symbol for Fast mode. Both use the same opacity and emoji font. A child or side chat using its parent's model and reasoning effort gets a dark red composer highlight; the speed setting is independent of that warning.
- Selection actions wait 1 second, then fade in over 500 ms while clicks remain disabled. Rich-text paste is retained; boundary whitespace is corrected only when the extra HTML whitespace agrees with the plain-text value. Clipboard contents stay out of logs.
- Every 10 minutes, the public Codex Resets `scheduled_reset` value is checked. A reported regular hard reset is drawn as a red line under the toolbar date axis. A null value removes the previous marker.

Speed and live-output measurements cover observed requests. When a native interface is unavailable, the manager retains the specific error while independent features continue working.

## Use

Requires Windows x64, standalone Node.js 24, PowerShell 7 and Codex. Install compatible Core and Chat enhancements packages, then add the `plugins` entry from `toolkit.example.json` to the existing configuration, preserving the other entries. Core shares the local CDP port and browser connection among components that need them.

```json
{ "module": "codex-toolkit-chat", "options": { "cdpPort": "auto" } }
```

Generate launch entries with Core's `prepare`, fully exit Codex and start through the generated entry. The settings button opens the shared manager; select **Chat enhancements** to inspect window interfaces or choose **Recheck**. After a native UI update, rechecking reinstalls this component's runtime integration.

History lookup uses `CODEX_SQLITE_HOME`, `CODEX_HOME` or the current user's `.codex` directory. For another Codex home, set an absolute `codexHome` in this component's options. That setting affects this component's history labels only.

The public reset-time lookup uses PowerShell 7 on Windows. If it is outside PATH, set its absolute `powershellPath` in the component options. The lookup accesses the public announcement using no Codex credentials or conversation content.

CDP grants broad application access and has no password authentication. Use it in a trusted local environment. Component code runs with the current user's permissions.

## Upgrade and disable

Exit Codex, stop Core, install compatible package versions and start through the same entry. Existing configuration and state are retained. To disable this component, remove its configuration entry. Conversation history, global Codex settings, model configuration and other components' state are preserved.

Scroll-position correction is opt-in. If a client version jumps to an earlier position when a message starts or ends, set `scrollHandoffEnabled: true` to preserve the reading position across native list replacement. Manual scrolling takes priority. For diagnosis, set `scrollDiagnosticsEnabled: true` to record scroll and turn timing in Core's `events.jsonl`; message text stays out of the log. Disable the option to stop collection.

Message delivery remains native. Window switching, sleep, Edge reading, update protection and voice controls are provided by their respective modules.
