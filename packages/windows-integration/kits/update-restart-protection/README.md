# Update restart protection

English | [简体中文](README.zh-CN.md)

Keeps the Toolkit's connection available across the official Codex update restart by protecting the registered restart arguments.

## Use

Install PowerShell 7. In the Kit runtime's `options.services`, set `restart-protection.module` to `codex-toolkit-windows/restart-protection-service`. Set `restart-protection.options.powershellPath` to the PowerShell 7 executable path when needed. Enable `update-restart-protection` in **Kits** and select **Restart Kit host**.

Use the Codex update button when an update is available. A green dot on the button indicates that the restart protection and registered arguments have been verified. If protection reports an error, check the manager for details; security software may block the process operation. The registered protection remains active until the Codex process exits.

Requires Core 0.3.23 or later.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
