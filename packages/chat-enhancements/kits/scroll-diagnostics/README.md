# Scroll diagnostics

English | [简体中文](README.zh-CN.md)

Records scroll operations and layout metadata to help diagnose unexpected changes in conversation position. Records can include conversation and turn identifiers, scroll positions, layout measurements and call stacks; review them before sharing.

Configure the `chat-diagnostics` service with module `codex-toolkit-chat/diagnostic-service`. Enable `scroll-diagnostics` in **Kits**, then choose **Restart Kit host**. The service writes the diagnostic records to the Toolkit log. Requires Core 0.3.23 or later.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
