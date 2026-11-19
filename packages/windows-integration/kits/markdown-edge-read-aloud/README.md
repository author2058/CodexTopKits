# Markdown read aloud

English | [简体中文](README.zh-CN.md)

Opens a Markdown file in Microsoft Edge and starts Edge's read-aloud feature from Codex.

## Use

Install Microsoft Edge and PowerShell 7. In the Kit runtime's `options.services`, set `read-aloud.module` to `codex-toolkit-windows/read-aloud-service`; set `read-aloud.options.powershellPath` to the PowerShell 7 executable path when needed. Enable `markdown-edge-read-aloud` in **Kits** and select **Restart Kit host**.

Right-click a `.md` file link in a conversation or a Markdown file in the file tree, then select **Open and read aloud with Microsoft Edge**. Edge opens in the foreground at 200% zoom and starts reading. The action switches the foreground window; if Edge cannot be brought forward or playback cannot be confirmed, check the manager for details.

Requires Core 0.3.39 or later.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
