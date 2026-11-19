# Project and chat colors

English | [简体中文](README.zh-CN.md)

Applies colors to the Codex main interface by project and chat. Chats can inherit their project color or use their own; accent, canvas, surface and sidebar colors can be enabled separately.

Enable `project-thread-colors` in **Kits** and choose **Restart Kit host**. Configure `theme-settings` as `codex-toolkit-themes/feature-service`. With Themes, set the service option `legacyPlugin` to `themes`, add `project-thread-colors` to Themes' `externalKits`, and choose colors in **Themes**. In a Kit-only setup, the service's `mapPath` option accepts an absolute theme-map path.

For a new installation, select `--kit project-thread-colors` with the [source installer](../../../../docs/getting-started.md#2-prepare-a-local-installation). It includes Themes and configures the color editor and service.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
