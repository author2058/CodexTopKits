---
name: codex-thread-runtime
description: Route cross-task messages safely and preserve a protected Codex v1 delegated child's model, reasoning effort, and service tier through unload, resume, and app restart.
---

# Codex Thread Runtime

Use the deterministic helper at `scripts/thread-runtime.mjs`; do not reproduce its HTTP calls manually. The protection registry distinguishes explicitly registered delegated children from ordinary peer Codex tasks. Mere observation of a task never makes it protected.

After `multi_agent_v1.spawn_agent` returns a child thread ID, register the exact requested model, effort, and service tier before sending further input:

```powershell
& {{NODE}} '{{RUNTIME_SCRIPT}}' register --thread-id '<thread-id>' --parent-thread-id '<parent-thread-id>' --model '<model>' --effort '<effort>' --service-tier '<tier>'
```

Before sending a prompt to any existing Codex task, classify and prepare the target:

```powershell
& {{NODE}} '{{RUNTIME_SCRIPT}}' prepare-send --thread-id '<thread-id>'
```

Obey the returned `route` exactly:

- `multi_agent_v1.send_input`: the target is a protected delegated child. `prepare-send` has already restored and verified its complete runtime tuple. Never substitute Codex App `send_message_to_thread`, because that path can apply the caller's current global service tier.
- `codex_app.send_message_to_thread`: the target is an ordinary peer task and the app tool is appropriate.

A helper failure is a hard gate: report it and do not send by another route. This prevents the first post-resume turn from running with inherited or global settings; restoring settings after a wrong send cannot repair that turn.

Use `ensure` directly only for an explicit recovery or diagnostic that is not immediately followed by a send:

```powershell
& {{NODE}} '{{RUNTIME_SCRIPT}}' ensure --thread-id '<thread-id>'
```

If the intended model, effort, tier, or parent changes, run `register` again with the complete tuple. The controller stores the protected baseline outside Codex, resumes the thread, atomically applies all three runtime settings, and verifies them by readback. Runtime notifications may trigger recovery but never overwrite the protected baseline.

`--service-tier fast` is accepted as the Codex config/ledger spelling. The controller canonicalizes it to the app-server runtime value `priority`; `show` therefore reports `priority` after registration.

This skill requires Codex to be running through Codex Desktop Toolkit with the SessionRecovery plugin enabled and its shared CDP connection active. It restores existing threads; it does not create v1 agents, convert v2 agents, register ordinary app-server threads in Core's v1 `AgentControl`, or intercept an already-invoked built-in app tool.
