# Restart with CodexTopKits

English | [简体中文](README.zh-CN.md)

Adds **File → Restart with CodexTopKits** to reopen Codex with the selected Kits and launch settings.

## Use

Choose the menu command to open a 20-second confirmation countdown. **Restart now** proceeds immediately; **Cancel**, Escape or closing the dialog keeps the current session open. When the countdown ends, Codex quits normally. Respond to any native unsaved-content prompt; the launcher waits for the old processes to exit, applies any prepared Toolkit update and reopens Codex.

Requires Core 0.3.39 or later, PowerShell 7 with Windows Forms Task Dialog support, and the `app-restart` service. Add this service inside the Kit runtime's `options.services`, using absolute local paths:

```json
{
  "app-restart": {
    "module": "codex-toolkit-core/app-restart-service",
    "options": {
      "configPath": "C:/CodexTopKits/state/local/toolkit.json",
      "powershellPath": "C:/Program Files/PowerShell/7/pwsh.exe"
    }
  }
}
```

Enable `app-restart` in **Kits**, then choose **Restart Kit host**. Service configuration follows the [installation guide](../../../../docs/getting-started.md#kits-with-shared-services).
