# CodexTopKits — Themes

Themes adds project and chat colors and UI font-size controls to Codex. The package imports as `codex-toolkit-themes` and requires [Core](../core/README.md). See the [installation guide](../../docs/getting-started.md) and [appearance Kits](../../README.md#appearance) for setup and individual features. The package is licensed under [Apache-2.0](LICENSE).

## 简体中文

CodexTopKits 的工程与会话配色组件，依赖 [Core](../core/README.md)。本包的安装名为 `codex-toolkit-themes`，使用 [Apache-2.0](LICENSE)。

本组件提供 12 个色相预设和深灰 neutral、工程配色、会话覆盖或继承、四类全局颜色开关，以及 11 到 24px 的 UI 字号覆盖。管理页中每个条目显示当前代表色；选择“原生”移除主题颜色，选择“继承”跟随所属工程。字号单独使用全局设置，不改编辑器或代码字体变量。

主题只作用于 Codex 主界面；右侧聊天区域保留原生颜色，桌宠和语音悬浮窗不应用主界面的背景和字号。底栏、输出标号、语音及 Windows 系统操作由其他组件独立维护，本包不自动安装或开启这些功能。

## 安装与启动

需要 Windows x64、独立 Node.js 24 和 PowerShell 7。按[安装指南](../../docs/getting-started.zh-CN.md)准备 Core，再选择需要的外观 Kits。

使用本包的 `toolkit.example.json` 作为安装配置，在其中补充独立 `powershellPath`，再运行 Core 的 `prepare` 生成启动和管理入口。完整退出 Codex 后，通过 `start-toolkit.cmd` 启动；使用 `open-manager.cmd` 打开工具集，再进入“主题与外观”。

本组件需要 CDP。`cdpPort` 默认为 `auto`，端口由 Core 统一分配；多个组件共享同一个浏览器连接和窗口目录，不各自建立控制器。需要固定端口时可在 options 中填写同一端口。随机端口不能代替认证：CDP 没有密码认证并具有高权限，只能在受信任本机环境使用；工具只连接和监听回环地址。

安装、导入源码或修改主题设置不会关闭正在工作的 Codex。首次启用 CDP 需要完整退出后重开；之后配色和字号修改即时分发，不需重启应用。

## 配置与兼容检查

主题配置默认位于工具集状态目录下的 `plugins/themes/theme-map.json`。也可在 options 中用绝对 `mapPath` 指向单独的配置文件。配置缺失时创建内置预设；已有配置解析失败时明确报错，不覆盖原文件。工程名、会话 ID 和自定义配色属于该机数据，不放入源码仓库。

工程归属优先使用当前会话的原生项目 ID、工程目录和会话元数据；侧栏只是可用的补充来源。窗口创建、导航、关闭、工程归属通知和配置文件变更触发更新，不循环扫描所有窗口。管理页通过 Core 的本机事件流更新，隐藏页面时停止订阅，展开的配色控件不因后台更新被重建。

管理页的“检查接口”重新检查当前主窗口。客户端升级后，模块、工程目录、消息桥或 DOM 接口变化会在管理页和 Core 健康结果中显示具体错误，不把“没有读取到”当成原生配色成功。新格式不兼容时不要同时启动旧主题控制器；本组件会报告重复拥有者，不覆盖旧注入。

## 升级与撤除

升级程序文件前，先完整退出通过本工具启动的 Codex，经 Core 停止服务并确认退出，再安装匹配版本；保留原配置和状态目录。本包不接管 Codex 官方安装更新。

单独移除 Themes 时，先停止本工具，再从配置的 plugins 列表移除此组件。停止会移除自身的样式、订阅、早期注入脚本和 CDP 会话，不停止其他组件拥有的浏览器 Tracing，也不删除个人配色。若不再需要任何 CDP 功能，完整退出 Codex 后从原生入口重新启动，以关闭调试端口。

## 已知限制

本组件依赖 Codex 的内部接口。客户端升级后可能无法换色或读取工程归属，管理页会显示具体问题；可先停用 Themes，保留其他组件。它不会修改 Codex 安装包，也不会自动回退到旧控制器。
