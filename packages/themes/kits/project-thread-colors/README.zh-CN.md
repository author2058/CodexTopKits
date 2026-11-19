# Project and chat colors

[English](README.md) | 简体中文

按项目和聊天为 Codex 主界面应用配色。聊天可继承项目配色或单独选择配色；强调色、画布、表面和侧边栏颜色可分别启用。

在 **插件** 中启用 `project-thread-colors`，再点击 **重启插件宿主**。将 `theme-settings` 服务配置为 `codex-toolkit-themes/feature-service`。使用 Themes 时，将服务选项 `legacyPlugin` 设为 `themes`，把 `project-thread-colors` 加入 Themes 的 `externalKits`，再在 **主题设置** 中选择配色。仅使用 Kit 时，可通过服务的 `mapPath` 指定主题配置文件的绝对路径。

首次安装时，在[源码安装工具](../../../../docs/getting-started.zh-CN.md#2-准备本地安装)中选择 `--kit project-thread-colors`，工具会安装 Themes 并配置配色编辑页与服务。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
