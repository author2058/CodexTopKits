# Awake bridge

[English](#awake-bridge) | [简体中文](#简体中文)

Keeps Windows awake while Codex conversations run and releases that state as activity finishes.

## Use

Install Windows Integration 0.2.22 or later and PowerShell 7. In the Kit runtime's `options.services`, set `windows.module` to `codex-toolkit-windows/feature-service` and `awake.module` to `codex-toolkit-windows/awake-service` (Awake service API 1.1.0 or later). Set either service's `options.powershellPath` to the PowerShell 7 executable path when needed. By default, the Kit stores its activity state in the Toolkit's private state directory. Disabling the Kit releases this installation's keep-awake state. To use an existing Awake script, set `awake.options.awakeScript` to its absolute path.

Enable `awake-bridge` in **Kits** and select **Restart Kit host**. The bridge forwards turn start and completion events and checks loaded conversation activity every 30 seconds while a Codex window is available. Requires Core 0.3.23 or later.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)

## 简体中文

在 Codex 会话运行时保持 Windows 唤醒，并在活动结束后释放唤醒状态。

安装 Windows Integration 0.2.22 或更高版本，以及 PowerShell 7。在 Kit 运行时的 `options.services` 中，将 `windows.module` 设置为 `codex-toolkit-windows/feature-service`，将 `awake.module` 设置为 `codex-toolkit-windows/awake-service`（Awake 服务 API 1.1.0 或更高版本）。需要时，可通过各服务的 `options.powershellPath` 指定 PowerShell 7 可执行文件路径。Kit 默认将活动状态保存在 Toolkit 的私有状态目录中；停用 Kit 会释放该安装的防睡眠状态。如需使用已有的 Awake 脚本，可将 `awake.options.awakeScript` 设置为该脚本的绝对路径。

在 **插件** 中启用 `awake-bridge`，选择 **重启插件宿主**。桥接器会转发回合开始和结束事件，并在 Codex 窗口可用时每 30 秒检查已加载会话的活动。需要 Core 0.3.23 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
