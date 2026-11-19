# Context recovery integration

[English](README.md) | 简体中文

安装恢复 skill 和仅在上下文压缩后触发的 SessionStart Hook，帮助 Codex 恢复当前工作断点。恢复过程按时间戳优先、有界地读取本地会话记录；集成还会安装子线程运行时 skill。

### 使用

安装 `codex-toolkit-session`，并将 Session Recovery 放在 Kit 宿主之前。在 Kit 宿主的 `services` 中使用绝对路径配置：

```json
{
  "context-recovery": {
    "module": "codex-toolkit-session/context-recovery-service",
    "options": {
      "codexHome": "C:/path/to/codex-home",
      "nodeExecutable": "C:/path/to/node.exe",
      "powershell": "C:/path/to/pwsh.exe"
    }
  }
}
```

使用独立 Node 可执行文件和 PowerShell 7。在 **插件** 中启用 `context-recovery-integration`，再点击 **重启插件宿主**。Codex 可能要求原生确认新增或更改的 Hook；在 Codex 中批准后，按需新建聊天或重启 Codex 以重新加载配置。停用 Kit 会移除其压缩恢复 Hook，并保留子线程运行时 skill 和其他 Hook。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
