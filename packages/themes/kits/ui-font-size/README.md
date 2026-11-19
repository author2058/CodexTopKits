# UI font size

English | [简体中文](README.zh-CN.md)

Sets the Codex main interface font size to an integer from 11 to 24 pixels. The default follows Codex, and editor and code font settings stay separate.

Enable `ui-font-size` in **Kits** and choose **Restart Kit host**. Configure the `theme-settings` service as `codex-toolkit-themes/feature-service`; with the Themes module, set its service option `legacyPlugin` to `themes` and add `ui-font-size` to Themes' `externalKits`. Choose the size in **Themes**. For a Kit-only setup, the service's `mapPath` option accepts an absolute theme-map path; set `uiFontSizeOverride` there.

For a new installation, select `--kit ui-font-size` with the [source installer](../../../../docs/getting-started.md#2-prepare-a-local-installation). It includes Themes and configures the settings page and service.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
