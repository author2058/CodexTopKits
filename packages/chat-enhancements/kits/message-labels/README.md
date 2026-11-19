# Message labels

English | [简体中文](README.zh-CN.md)

Message labels adds a turn-relative number and local time to assistant messages. Numbers cycle through six colors, with matching rails alongside related activity.

## Use

Configure the `chat-history` service with module `codex-toolkit-chat/history-service`, enable `message-labels` in **Kits**, then choose **Restart Kit host**. The service reads the local Codex history database to supply message identifiers, numbers and timestamps for partially loaded completed turns. For a custom Codex directory, set the service's optional `options.codexHome` to its absolute path. The Kit requires Core 0.3.23 or later.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
