# CodexTopKits — Chat enhancements

Chat enhancements add conversation indicators, navigation and presentation features to Codex. The package imports as `codex-toolkit-chat` and requires [Core](../core/README.md) 0.3.16 or a compatible later version. See the [installation guide](../../docs/getting-started.md) and [Kits](../../README.md#conversations) for setup and individual features. The package is licensed under [Apache-2.0](LICENSE).

## 简体中文

为 Codex 桌面端提供聊天区增强，依赖 [Core](../core/README.md) 0.3.16 或更新的兼容版本。组件独立安装，不依赖 Themes 或 Traffic；与 Themes 同时使用时，底栏沿用侧栏颜色。

本包的 npm 导入名为 `codex-toolkit-chat`，使用 [Apache-2.0](LICENSE)。

## 功能

- 底栏显示原生每周余量、重置时间及用量／时间进度。原生缓存发生变化时同步，不额外轮询用量接口。右侧设置按钮进入 Core 管理页，接口异常时显示问题数量。
- 主聊天、side chat 和无输入框子代理均有固定在输出区底部的速度标签。标签保留上次有效结果，新测量未完成时追加 `...`；数据来自精确原生 token 数与对应响应的请求、首响和末响时间，不按字符数估算，也不把工具运行时间混进另一条响应。
- 助手正文按回合显示六色循环序号、时分及细竖线，装饰不占原生布局空间。已加载历史使用原生身份匹配；分页不完整时从本机历史数据库读取该回合的序号与时间。
- 展开历史过程且未加载完整时显示“显示全部”，通过原生接口加载该回合剩余内容。不会自动展开或重放全部历史。
- 输入框顶部显示上下文用量条；预测文字不算实际输入，压缩期间停止闪烁并变灰。
- 输入框下方显示运行计时条，结束后保留计时；点击可打开流式模型输出小面板。面板只显示当前窗口实际收到的模型文字、工具输入及修改内容，保留最新50行；不显示工具返回、协议包装或不可见的内部思考，不回补窗口未渲染时遗漏的内容。
- 展开原生已收到的思考摘要、统一表格字号与内部边框、图片浮层醒目关闭按钮，以及文件行号定位高亮。
- 输入框上方显示标题中的第一个 emoji，快速模式显示闪电，两者使用相同的透明度和 Emoji 字体。子代理或 side chat 的模型和思考等级与父会话相同时，输入框底部显示暗红渐变；速度不同不影响提醒。
- 圈选文字的操作浮层延迟 1 秒，再用 500 毫秒淡入，淡入期间不接受鼠标点击。粘贴保留原生富文本，仅在 HTML 多出首尾空白且与纯文本内容一致时修正边界；日志不保存剪贴板正文。
- 每 10 分钟读取一次 Codex Resets 的公开 `scheduled_reset`，有明确的常规硬重置时间时，在底栏日期轴下层显示红线。返回空值时立即移除旧线，不使用其他预告字段代替。

速度和流式小面板不会为历史请求虚构数据。原生版本没有提供某项接口时，管理页会保留具体错误，其他独立功能继续运行。

## 使用

需要 Windows x64、独立 Node.js 24、PowerShell 7 和已安装的 Codex。先安装匹配版本的 Core 与本插件，再将 `toolkit.example.json` 中的 `plugins` 条目加入自己的配置；不要覆盖已有其他插件设置。Core 的启动入口会为需要 CDP 的插件共用本机随机端口和同一条浏览器连接。

```json
{ "module": "codex-toolkit-chat", "options": { "cdpPort": "auto" } }
```

通过 Core 的 `prepare` 生成启动入口，完全退出 Codex 后使用该入口启动。设置按钮打开共同管理页，选择“聊天增强”查看窗口接口状态或点击“重新检查”。原生界面升级后，重新检查会重新安装本插件，不改 Codex 安装包。

默认历史数据库来自 `CODEX_SQLITE_HOME`、`CODEX_HOME` 或当前用户的 `.codex`。使用非默认 Codex 用户目录时，可在本插件 `options` 中显式设置绝对路径 `codexHome`；这只影响本插件的历史标签读取，不更改 Codex 的用户目录。

公开重置时间查询在 Windows 上使用 PowerShell 7；若它不在 PATH，可在本插件选项填写 `powershellPath` 的绝对路径。此查询只访问公开公告，不发送 Codex 认证或会话内容。

CDP 没有密码认证且权限较高，只应在受信任的本机环境启用。本插件代码拥有当前用户权限，不提供安全沙箱。

## 升级和停用

先退出 Codex，再停止 Core，安装匹配版本并从同一入口启动。升级保留原配置与状态。停用时从配置移除本插件；它不会改写历史内容、全局 Codex 设置、模型配置或其他插件状态。

默认不修改滚动位置。若当前版本在消息开始或结束时跳回旧位置，可在插件选项中设置 `scrollHandoffEnabled: true`，保留原生列表替换前的阅读位置；手动滚动仍优先，不强制滚到底部。需要排查时设置 `scrollDiagnosticsEnabled: true`，在 Core 的 `events.jsonl` 中记录滚动和回合时序，不记录消息正文；关闭该选项即停止采集。

本插件不接管消息队列或发送，不包含窗口切换、睡眠、Edge 朗读、更新接管和语音音量控制。
