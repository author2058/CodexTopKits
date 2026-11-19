# Agent model protection

English | [简体中文](README.zh-CN.md)

Helps preserve the model, reasoning effort and service tier of explicitly registered v1 child chats through unload and resume. This opt-in Kit is disabled by default and uses Session Recovery's registry and send-preparation workflow.

## Use

Install `codex-toolkit-session` and Core 0.3.39 or later. Place Session Recovery before the Kit runtime and set its `externalKits` option to `["agent-model-protection"]`. Configure `services.session-runtime.module` in the Kit runtime as `codex-toolkit-session/model-protection-service`, then enable `agent-model-protection` in **Kits** and choose **Restart Kit host**.

Register a v1 child with its complete settings, then prepare each send through the returned route. Replace the placeholders with the installed CLI, Core state directory, child and parent IDs, and desired settings:

```powershell
node '<installation>/node_modules/codex-toolkit-session/src/cli.mjs' register --state-directory '<Core state directory>' --thread-id '<child ID>' --parent-thread-id '<parent ID>' --model '<model>' --effort '<effort>' --service-tier '<tier>'
node '<installation>/node_modules/codex-toolkit-session/src/cli.mjs' prepare-send --state-directory '<Core state directory>' --thread-id '<child ID>'
```

`prepare-send` restores and checks the registered settings before returning the route. Re-register the complete tuple to change it. Protection registrations persist when the Kit is disabled; protected send preparation requires the Kit. To end protection, run the same CLI with `unprotect --state-directory '<Core state directory>' --thread-id '<child ID>'`. Session Recovery retains the recorded settings and the chat.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
