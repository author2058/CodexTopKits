# Awake bridge

[English](README.md) | 简体中文

在 Codex 会话运行时保持 Windows 唤醒，并在活动结束后释放唤醒状态。

安装 Windows Integration 0.2.22 或更高版本，以及 PowerShell 7。在 Kit 运行时的 `options.services` 中，将 `windows.module` 设置为 `codex-toolkit-windows/feature-service`，将 `awake.module` 设置为 `codex-toolkit-windows/awake-service`（Awake 服务 API 1.1.0 或更高版本）。需要时，可通过各服务的 `options.powershellPath` 指定 PowerShell 7 可执行文件路径。Kit 默认将活动状态保存在 Toolkit 的私有状态目录中；停用 Kit 会释放该安装的防睡眠状态。如需使用已有的 Awake 脚本，可将 `awake.options.awakeScript` 设置为该脚本的绝对路径。

在 **插件** 中启用 `awake-bridge`，选择 **重启插件宿主**。桥接器会转发回合开始和结束事件，并在 Codex 窗口可用时每 30 秒检查已加载会话的活动。需要 Core 0.3.23 或更高版本。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
