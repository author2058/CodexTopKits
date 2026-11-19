# UI font size

[English](#ui-font-size) | [简体中文](#简体中文)

Sets the Codex main interface font size to an integer from 11 to 24 pixels. The default follows Codex, and editor and code font settings stay separate.

Enable `ui-font-size` in **Kits** and choose **Restart Kit host**. Configure the `theme-settings` service as `codex-toolkit-themes/feature-service`; with the Themes module, set its service option `legacyPlugin` to `themes` and add `ui-font-size` to Themes' `externalKits`. Choose the size in **Themes**. For a Kit-only setup, the service's `mapPath` option accepts an absolute theme-map path; set `uiFontSizeOverride` there.

For a new installation, select `--kit ui-font-size` with the [source installer](../../../../docs/getting-started.md#2-prepare-a-local-installation). It includes Themes and configures the settings page and service.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)

## 简体中文

将 Codex 主界面字号设置为 11 至 24 像素的整数。默认跟随 Codex，编辑器与代码字体设置保持独立。

在 **插件** 中启用 `ui-font-size`，再点击 **重启插件宿主**。将 `theme-settings` 服务配置为 `codex-toolkit-themes/feature-service`；使用 Themes 模块时，将服务选项 `legacyPlugin` 设为 `themes`，并将 `ui-font-size` 加入 Themes 的 `externalKits`，然后在 **主题设置** 中选择字号。仅使用 Kit 时，可通过服务的 `mapPath` 指定主题配置文件的绝对路径，并在文件中设置 `uiFontSizeOverride`。

首次安装时，在[源码安装工具](../../../../docs/getting-started.zh-CN.md#2-准备本地安装)中选择 `--kit ui-font-size`，工具会安装 Themes 并配置设置页面与服务。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
