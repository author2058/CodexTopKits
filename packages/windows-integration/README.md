# CodexTopKits — Windows Integration

Windows Integration provides Codex window tabs, scheduled sleep, Markdown read-aloud and update-restart protection. It requires [Core](../core/README.md) 0.3.16 or a compatible later version. See the [installation guide](../../docs/getting-started.md) and [desktop Kits](../../README.md#toolbar-and-desktop) for setup and individual features. The package is licensed under [Apache-2.0](LICENSE).

## 简体中文

为 Windows x64 上的 Codex 桌面端提供底栏窗口标签、完成后睡眠、Markdown 朗读菜单和更新后调试参数保护。组件依赖 [Core](../core/README.md) 0.3.16 或更新的兼容版本，可以单独安装，不依赖聊天、主题或流量组件。

## 使用

需要 Windows、Node.js 24 或更新版本，以及已安装的 PowerShell 7。将此包与 Core 安装到同一独立目录，在 Core 的配置文件中加入 `toolkit.example.json` 中的插件条目。PowerShell 不在 PATH 时，在插件选项中填写 `powershellPath` 的绝对路径。由 Core 启动 Codex，或配置同一个已开放的本机 CDP 端口。

底栏居中平铺当前已打开的窗口，点击标签切换窗口，保留其最大化状态。每个窗口通过底栏控件的独立系统标识与实际进程配对，不依赖标题唯一，也不按列表位置猜测窗口。标签随会话变化更新，运行标记优先于完成未读标记；首次启用前已经存在的未读状态不追溯。工具运行期间新开窗口按创建顺序排列；工具启动前已存在的窗口按初次发现顺序排列。若无法确认窗口身份，标签会报告具体问题。

月亮默认关闭。点亮后，全部本地会话结束并静置一分钟，插件再读取原生会话状态；确认没有运行中的会话后，先关闭所有窗口的月亮，再请求 Windows 睡眠。新回合会取消待执行的睡眠。系统睡眠与唤醒均关闭开关，不会因唤醒再次自动睡眠。

设置入口打开 Core 共用管理页面。错误以红色数字显示，页面中可查看具体原因。插件不修改 Codex 安装包、系统音量、启动项或系统电源计划；需要当前登录桌面用户的普通权限，不要求管理员权限。CDP 仍具有控制应用和读取会话数据的能力，必须只向可信的本机程序开放。

聊天文件链接和文件浏览器中，Markdown 文件的原生右键菜单会追加“用 Microsoft Edge 打开并朗读”。该操作打开普通 Edge 窗口、设置 200% 缩放、确认窗口在前台后启动原生朗读，并检查是否出现播放中的暂停按钮。操作会切换前台窗口；如果 Windows 不允许切换或 Edge 未确认播放，管理页会显示具体原因。其他文件和原生菜单项保持不变。

官方更新按钮仍使用 Codex 自己的安装方法。插件只在当前官方 Codex 主进程内保护原生更新器的 Windows 重启参数，使官方重启继续带有本机 CDP；不查询或选择版本、不下载或替换安装包、不改变其他重启参数或标志。按钮右下的绿色圆点表示保护入口和登记结果已经读回确认；未确认时不显示绿点，失败在管理页报告。保护会保留到该 Codex 进程退出，不修改磁盘上的安装文件；安全软件可能阻止此进程内操作。

窗口布局恢复继续关闭，不会自动补开或移动窗口。

底栏保留“清理云端未读”按钮。点击只清理原生接口确认的云端未读，不更改本地会话；即使没有未读，按钮也保持显示。Dot 工作区参与窗口切换，标题变化时同步更新，不伪装成本地会话。

已有 Codex Awake 脚本的机器，可在插件选项中将 `awakeScript` 指向 `Update-CodexAwakeState.ps1` 的绝对路径。插件转发原生回合开始与完成事件，并每30秒核对一次已加载会话，帮助中止或失败的回合结束保持唤醒；不安装或修改全局 Awake Hook。没有该脚本时不设置此选项。

## 开发

`npm test` 执行自动检查，睡眠状态测试使用注入的时钟和模拟动作，不让本机睡眠。`node test/browser-smoke.mjs <Edge绝对路径>` 在独立的无头浏览器配置中检查控件、样式和清理。真实窗口切换需要在已授权的专用 Codex 实例中验证。

`pwsh -NoProfile -File test/set-codex-restart.test.ps1` 在测试进程内检查 x64 保护代码，不调用真实应用或更新器。不要向该脚本传入真实 PID，除非明确需要检查已经安装的进程内保护。

本包使用 [Apache-2.0](LICENSE)。
