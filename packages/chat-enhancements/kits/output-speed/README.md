# Output speed

English | [简体中文](README.zh-CN.md)

Displays generation speed, end-to-end speed and time to first response for observed model responses in the main chat, side chats and agent panels. Speeds use the response's native output token count: generation covers the interval between the first and last model content, while end-to-end speed includes request wait time.

## Use

Enable `output-speed` in **Kits**, then choose **Restart Kit host**. The latest measurements remain visible while browsing the conversation. During a new measurement, the previous values display with `...`; unavailable values display as `—`. Measurements cover responses observed while the Kit and window are active.

Requires Core 0.3.39 or later.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
