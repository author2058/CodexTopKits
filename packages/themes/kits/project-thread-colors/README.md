# Project and chat colors

[English](#project-and-chat-colors) | [简体中文](#简体中文)

Applies colors to the Codex main interface by project and chat. Chats can inherit their project color or use their own; accent, canvas, surface and sidebar colors can be enabled separately.

Enable `project-thread-colors` in **Kits** and choose **Restart Kit host**. Configure `theme-settings` as `codex-toolkit-themes/feature-service`. With Themes, set the service option `legacyPlugin` to `themes`, add `project-thread-colors` to Themes' `externalKits`, and choose colors in **Themes**. In a Kit-only setup, the service's `mapPath` option accepts an absolute theme-map path.

For a new installation, select `--kit project-thread-colors` with the [source installer](../../../../docs/getting-started.md#2-prepare-a-local-installation). It includes Themes and configures the color editor and service.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)

## 简体中文

按项目和聊天为 Codex 主界面应用配色。聊天可继承项目配色或单独选择配色；强调色、画布、表面和侧边栏颜色可分别启用。

在 **插件** 中启用 `project-thread-colors`，再点击 **重启插件宿主**。将 `theme-settings` 服务配置为 `codex-toolkit-themes/feature-service`。使用 Themes 时，将服务选项 `legacyPlugin` 设为 `themes`，把 `project-thread-colors` 加入 Themes 的 `externalKits`，再在 **主题设置** 中选择配色。仅使用 Kit 时，可通过服务的 `mapPath` 指定主题配置文件的绝对路径。

首次安装时，在[源码安装工具](../../../../docs/getting-started.zh-CN.md#2-准备本地安装)中选择 `--kit project-thread-colors`，工具会安装 Themes 并配置配色编辑页与服务。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
