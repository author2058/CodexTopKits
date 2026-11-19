# Live model output

English | [简体中文](README.zh-CN.md)

Shows the latest 50 lines of observed model output for the current chat, including model-authored text and tool inputs.

## Use

Enable `live-model-output` and its [composer timer](../composer-timer/README.md) dependency in **Kits**, then choose **Restart Kit host**. During a turn, click the timer bar below the composer to show or hide the output panel. The panel continues collecting observed output while closed, clears at the start of a new turn and closes when the turn finishes.

The panel covers output observed while the Kit and window are active. Requires Core 0.3.39 or later and `composer-timer` 0.1.0 or later within the 0.1 series; the timer also requires the `chat-diagnostics` service.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
