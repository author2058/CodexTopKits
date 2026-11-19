# Rich paste boundary

English | [简体中文](README.zh-CN.md)

Keeps rich formatting and links while trimming extra whitespace at the edges of pasted HTML when its plain-text representation confirms the same content and has clean boundaries.

Configure the `chat-diagnostics` service with module `codex-toolkit-chat/diagnostic-service`. Enable `rich-paste-boundary` in **Kits**, then choose **Restart Kit host**. The adjustment applies automatically when pasting eligible rich text into the composer. The service records paste lengths and a diagnostic reason.

Requires Core 0.3.23 or later.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
