# Context recovery integration

English | [简体中文](README.zh-CN.md)

Installs a recovery skill and a compact-only SessionStart Hook that help Codex recover the current breakpoint after context compaction. Recovery uses timestamp-first, bounded reads of local session records. The integration also installs the child-thread runtime skill.

## Use

Install `codex-toolkit-session` and place Session Recovery before the Kit runtime. In the Kit runtime's `services`, configure the following with absolute paths:

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

Use a standalone Node executable and PowerShell 7. Enable `context-recovery-integration` in **Kits** and choose **Restart Kit host**. Codex may ask for native approval of the installed or changed Hook; approve it in Codex, then start a new chat or restart Codex when needed to reload its configuration. Disabling the Kit removes its compact Hook and retains the child-thread runtime skill and unrelated Hooks.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
