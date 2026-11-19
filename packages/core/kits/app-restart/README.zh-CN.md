# Restart with CodexTopKits

[English](README.md) | 简体中文

在菜单中添加 **File → Restart with CodexTopKits**，使用所选 Kits 和启动设置重开 Codex。

点击该命令会出现 20 秒确认倒计时。**立即重启**会马上继续；**取消**、Escape 或关闭弹窗会保留当前会话。倒计时结束后，Codex 正常退出。如原生界面询问未保存内容，请处理提示；启动器会等待旧进程退出，应用已准备的 Toolkit 更新，再重新打开 Codex。

需要 Core 0.3.39 或更高版本、支持 Windows Forms Task Dialog 的 PowerShell 7，以及 `app-restart` 服务。在 Kit 运行器的 `options.services` 中添加[英文页中的配置示例](README.md#use)，并将两个路径改为实际绝对路径。启用 `app-restart` 后，点击 **重启插件宿主**。服务配置步骤参见[安装指南](../../../../docs/getting-started.zh-CN.md#使用共享服务的-kits)。

[全部 Kits](../../../../README.zh-CN.md#kits)
