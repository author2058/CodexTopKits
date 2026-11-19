# Kit inventory

Updated at 2026-11-19 19:05 (Asia/Taipei). The Kits listed here have individual artifacts. Each named service dependency requires its `^1.0.0` service API and Core 0.3.23 or later. Shared services and native integrations have the lifecycle limits described in the Kit guide.

| Kit | Version | Dependencies | Focused tests |
| --- | --- | --- | --- |
| `footer` | `0.1.7` | Core `0.3.39` | `packages/core/test/footer.test.mjs`, `packages/core/test/feature-pack.test.mjs` |
| `manager-entry` | `0.1.4` | Core `0.3.39`, `footer@^0.1.4` | `packages/core/test/manager-entry.test.mjs` |
| `app-restart` | `0.1.2` | Core `0.3.39`, `app-restart` service | `packages/core/test/app-restart.test.mjs`, `packages/core/test/deployment.test.mjs` |
| `ui-font-size` | `0.1.3` | Core `0.3.23`, `theme-settings` service | `packages/themes/test/plugin.test.mjs`, `packages/themes/test/browser-smoke.mjs` |
| `project-thread-colors` | `0.1.5` | Core `0.3.23`, `theme-settings` service | `packages/themes/test/model.test.mjs`, `packages/themes/test/plugin.test.mjs`, `packages/themes/test/browser-smoke.mjs` |
| `profile-panel-shadow` | `0.1.2` | None | `packages/themes/test/browser-smoke.mjs` |
| `voice-volume` | `0.1.4` | Core `0.3.39` | `packages/voice-controls/test/voice-volume.test.mjs`, `packages/voice-controls/test/browser-smoke.mjs` |
| `weekly-usage` | `0.1.7` | Core `0.3.39`, `footer@^0.1.1` | `packages/chat-enhancements/test/feature-weekly-usage.test.mjs`, `packages/chat-enhancements/test/usage-localization.test.mjs` |
| `scheduled-reset-marker` | `0.1.8` | Core `0.3.39`, `weekly-usage@^0.1.4`, `scheduled-reset` service | `packages/chat-enhancements/test/scheduled-reset-feature.test.mjs`, `packages/chat-enhancements/test/usage-localization.test.mjs` |
| `table-style` | `0.1.2` | None | `packages/chat-enhancements/test/style-kits.test.mjs` |
| `image-viewer-close` | `0.1.4` | None | `packages/chat-enhancements/test/style-kits.test.mjs` |
| `selection-actions-delay` | `0.1.2` | None | `packages/chat-enhancements/test/selection-actions-kit.test.mjs` |
| `file-line-highlight` | `0.1.3` | None | `packages/chat-enhancements/test/file-line-highlight.test.mjs` |
| `rich-paste-boundary` | `0.1.3` | Core `0.3.23`, `chat-diagnostics` service | `packages/chat-enhancements/test/rich-paste-kit.test.mjs` |
| `context-meter` | `0.1.3` | None | `packages/chat-enhancements/test/context-usage.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `output-speed` | `0.1.4` | Core `0.3.39`, None | `packages/chat-enhancements/test/output-speed.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `composer-timer` | `0.1.6` | Core `0.3.39`, `chat-diagnostics` service | `packages/chat-enhancements/test/composer-timer-kit.test.mjs`, `packages/chat-enhancements/test/composer-timer.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `live-model-output` | `0.1.3` | Core `0.3.39`, `composer-timer@^0.1.0` | `packages/chat-enhancements/test/live-output.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `message-labels` | `0.1.7` | Core `0.3.23`, `chat-history` service | `packages/chat-enhancements/test/message-labels.test.mjs`, `packages/chat-enhancements/test/message-label-history.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `history-show-all` | `0.1.4` | Core `0.3.39`, None | `packages/chat-enhancements/test/turn-history.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `title-emoji` | `0.1.6` | None | `packages/chat-enhancements/test/model-decorations.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `fast-mode-indicator` | `0.1.6` | Core `0.3.39`, None | `packages/chat-enhancements/test/model-decorations.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `child-model-warning` | `0.1.6` | None | `packages/chat-enhancements/test/model-decorations.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `scroll-handoff-fix` | `0.1.3` | Core `0.3.23`, `chat-diagnostics` service | `packages/chat-enhancements/test/scroll-handoff.test.mjs`, `packages/chat-enhancements/test/scroll-kit.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `scroll-diagnostics` | `0.1.3` | Core `0.3.23`, `chat-diagnostics` service | `packages/chat-enhancements/test/scroll-diagnostics.test.mjs`, `packages/chat-enhancements/test/scroll-kit.test.mjs`, `packages/chat-enhancements/test/browser-smoke.mjs` |
| `window-tabs` | `0.1.10` | Core `0.3.39`, `footer@^0.1.3`, `windows` service | `packages/windows-integration/test/footer-features.test.mjs`, `packages/windows-integration/test/footer-localization.test.mjs` |
| `auto-sleep` | `0.1.8` | Core `0.3.39`, `footer@^0.1.1`, `windows` service | `packages/windows-integration/test/footer-features.test.mjs`, `packages/windows-integration/test/auto-sleep.test.mjs`, `packages/windows-integration/test/footer-localization.test.mjs` |
| `cloud-mark-read` | `0.1.4` | Core `0.3.39`, `footer@^0.1.1` | `packages/windows-integration/test/footer-features.test.mjs` |
| `markdown-edge-read-aloud` | `0.1.4` | Core `0.3.39`, `read-aloud` service | `packages/windows-integration/test/read-aloud.test.mjs`, `packages/windows-integration/test/browser-smoke.mjs` |
| `update-restart-protection` | `0.1.5` | Core `0.3.23`, `restart-protection` service | `packages/windows-integration/test/restart-protection.test.mjs`, `packages/windows-integration/test/update-indicator.test.mjs`, `packages/windows-integration/test/browser-smoke.mjs` |
| `agent-composer` | `0.1.4` | Core `0.3.39` | `packages/session-recovery/test/plugin.test.mjs`, `packages/session-recovery/test/browser-smoke.mjs` |
| `agent-model-protection` | `0.1.4` (opt-in; disabled by default) | Core `0.3.39`, `session-runtime` service | `packages/session-recovery/test/runtime.test.mjs`, `packages/session-recovery/test/plugin.test.mjs`, `packages/session-recovery/test/browser-smoke.mjs` |
| `awake-bridge` | `0.1.5` | Core `0.3.23`, `windows` and `awake` services | `packages/windows-integration/test/awake-bridge.test.mjs`, `packages/windows-integration/test/awake-service.test.mjs`, `packages/windows-integration/test/awake-runtime.test.mjs`, `packages/windows-integration/test/awake-assets.test.mjs`, `packages/windows-integration/test/plugin.test.mjs` |
| `image-reference-dedup` | `0.1.3` | Core `0.3.23`, `image-reference` service | `packages/traffic/test/image-reference-transform.test.mjs`, `packages/traffic/test/transform-router.test.mjs`, `packages/traffic/test/image-reference-proxy.test.mjs`, `packages/traffic/test/image-reference-runtime.test.mjs` |
| `context-recovery-integration` | `0.1.4` | Core `0.3.23`, `context-recovery` service | `packages/session-recovery/test/integration.test.mjs`, `packages/session-recovery/test/context-recovery.test.mjs`, `packages/session-recovery/test/context-recovery-runtime.test.mjs` |
| `image-policy-rules` | `0.1.5` | Core `0.3.23`, `image-policy` service | `packages/traffic/test/image-integration.test.mjs`, `packages/traffic/test/prepare-model-image.test.mjs`, `packages/traffic/test/native-image-policy-watch.test.mjs`, `packages/traffic/test/image-policy-runtime.test.mjs` |
| `traffic-observer` | `0.1.7` | Core `0.3.23`, `traffic-observer` service | `packages/traffic/test/traffic-log.test.mjs`, `packages/traffic/test/traffic-service.test.mjs`, `packages/traffic/test/traffic-cdp-service.test.mjs`, `packages/traffic/test/traffic-observer-router.test.mjs`, `packages/traffic/test/traffic-observer-runtime.test.mjs` |

Each Kit's directory contains its manifest and entry; shared services stay in their module's `src/`. The [Kit guide](../packages/core/docs/features.md) describes artifact creation, local update preparation, host restart and the third-party contract. A prepared Kit update is not automatically installed into the currently running toolkit.

`reasoning-summary-expand` is retired and has no active Kit artifact. Use `live-model-output` for the replacement experience.
