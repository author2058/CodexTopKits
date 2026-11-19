# CodexTopKits — SessionRecovery

English | [简体中文](README.zh-CN.md)

SessionRecovery provides optional protection for explicitly registered v1 child chats' model, reasoning effort and service tier when Codex unloads or resumes them. Current v2 workflows use Codex's native settings restoration. Its optional recovery rules help Codex recover the current breakpoint after context compaction without replaying a whole conversation.

This component depends on [Core](../core/README.md) 0.3.5 or newer. It uses Core's existing loopback CDP connection, management page and private state directory. It does not modify the Codex installation or open another debugging port.

## Enable the plugin

Install the Core and SessionRecovery packages together, then add this entry to the Core configuration's `plugins` array:

```json
{
  "module": "codex-toolkit-session",
  "options": { "cdpPort": "auto", "restoreAgentComposer": false, "externalKits": ["agent-model-protection"] }
}
```

Start Codex through the Toolkit entry. Open **Session Recovery** in the Toolkit manager to see protected children and recovery errors. Nothing is registered merely because a chat is open or observed.

`restoreAgentComposer` optionally reopens a restored read-only v1 child in Codex's existing interactive child panel. The plugin first verifies the native route and parent relationship. A changed or ambiguous interface is reported instead of replacing the panel blindly. This option does not convert v2 agents or enable direct input where Codex does not support it.

## Protect an existing v1 child

Enable the optional `agent-model-protection` Kit in the Kits page first. From Kit 0.1.3 and Core 0.3.37 it defaults to disabled; existing explicit selections remain unchanged. SessionRecovery does not enable a built-in replacement when the Kit is disabled. Ordinary v2 agents do not need protection registration.

Run the following with standalone Node. Use the actual installed CLI and absolute Core state directory:

```powershell
node '<installation>/node_modules/codex-toolkit-session/src/cli.mjs' register --state-directory '<Core state directory>' --thread-id '<child ID>' --parent-thread-id '<parent ID>' --model '<model>' --effort '<effort>' --service-tier '<tier>'
node '<installation>/node_modules/codex-toolkit-session/src/cli.mjs' prepare-send --state-directory '<Core state directory>' --thread-id '<target ID>'
```

Registration must specify all three settings. `fast` is normalized to `priority`; `null` explicitly clears effort or tier. `prepare-send` restores the complete tuple and reads it back before returning a send route:

- Protected v1 child: `multi_agent_v1.send_input`.
- Ordinary peer chat: `codex_app.send_message_to_thread`, without changing its settings.

Use exactly the returned route. A failed preparation must stop the send, not fall back to another tool. Re-register the complete tuple to change a protected baseline. Native notifications may trigger recovery but never replace that baseline.

`ensure` performs an explicit restoration and readback without preparing a message. `show` reads the current plugin state. `register --no-ensure` only records the baseline and does not verify native settings.

To stop protecting a registered target, run `unprotect --state-directory '<Core state directory>' --thread-id '<child ID>'` with the same installed CLI. It retains the recorded settings and the chat, ends automatic enforcement, and returns future send preparation to the ordinary route. Disabling the Kit alone keeps existing registrations protected, so their sends remain blocked until protection is explicitly ended or the Kit is enabled again.

If an older active Kit cannot safely release protection, the command asks for an update to 0.1.3 or later, or for the Kit to be disabled first. Its existing registration is retained when this preflight is rejected.

The plugin restores existing chats; it does not create v1 children, add missing tools, intercept an already-invoked built-in send, or guarantee protection when callers bypass preparation.

## Install the recovery skills and Hook

Use explicit paths for the Codex home, Core state directory and installed PowerShell 7:

```powershell
node '<installation>/node_modules/codex-toolkit-session/src/cli.mjs' install-rules --codex-home '<Codex home>' --state-directory '<Core state directory>' --powershell '<PowerShell 7 executable>'
```

This installs `context-recovery`, `codex-thread-runtime` and the compact-only SessionStart Hook. The installed runtime helper remembers this Toolkit state directory. The context helper uses timestamp-first, bounded reads of local rollout files; it does not upload them. Native side conversations skip extra recovery. Recovery errors remain visible rather than authorizing work from an uncertain breakpoint.

The installer preserves other Hooks and Codex trust state. It refuses to overwrite skills from another installation or files with local edits. Codex may request approval for the new Hook; installation does not grant that approval. After approving it, start a new chat or restart Codex if the current client has not reloaded its skill or Hook configuration.

`rules-status` checks the installed files. `remove-rules` removes only the recorded files and exact Hook group; it preserves unrelated configuration, trust state, backups and protection settings. Both accept the same `--codex-home` and `--state-directory` arguments.

## Data and requirements

Node.js 24 or newer and Core 0.3.5 or newer are required. Windows recovery Hooks require PowerShell 7. Settings and installation receipts live under Core's `plugins/session` directory. Skills and the Hook live in the explicitly selected Codex home. Keep these machine-specific files out of source control.

The package is licensed under [Apache-2.0](LICENSE).
