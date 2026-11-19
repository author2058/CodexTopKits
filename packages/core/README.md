# CodexTopKits — Core

English | [简体中文](README.zh-CN.md)

Kit APIs and independent artifact instructions: [Kits](docs/features.md). The first standalone definition is [Footer](kits/footer/README.md); existing aggregate module entry points remain compatible.

Failed components automatically retry their recovery operation, waiting 5 seconds between completed attempts. The default health indicator stays quiet for the first minute of a continuous failure, then shows the error while retries continue. A successful health report clears the error immediately and stops that component's retries. Components that are working normally have no retry timer. Diagnostics retain the original failure details. Recovery does not replay model requests or user actions, restart Codex, or activate prepared Kit updates.

Aggregate plugins may provide an idempotent `recover()` method; Core otherwise uses their existing `check()` method. Each operation must report its current outcome through `context.setHealth()`. Core serializes retries per plugin, preserves the first-failure deadline across failed attempts, and cancels retry timers when the host closes. Healthy progress reported during an attempt is confirmed when that attempt completes successfully; it cannot reset the deadline if initialization subsequently fails. A pending health result includes `recovering: true` and `issueCount: 0`; detailed plugin diagnostics remain available from their management endpoints.

Since Core 0.3.43, report `recoverable: false` through `context.setHealth()` when reconnecting cannot repair the reported failure. These failures are shown immediately and are not automatically retried by Core; a healthy report clears them, and an explicit check remains available. Renderer-reported Kit errors use this mode. Other components retain the existing recovery behavior. Kit error and recovery transitions are recorded in the existing `stateDirectory/events.jsonl` as `kit-health-changed`, including the target, execution context and original error details.

Core is the shared runtime foundation for CodexTopKits. Independent Kits use its public interfaces. [Traffic](../traffic/README.md) provides image bandwidth tools and measurement, and [Themes](../themes/README.md) manages appearance. The package imports as `codex-toolkit-core`.

The package is licensed under [Apache License 2.0](LICENSE).

Core provides component lifecycle management, on-demand shared CDP, dedicated state directories, UTF-8 logs, health results and Windows launch entries. Appearance, voice and image-processing features are supplied by their own components. Importing Core only loads its API; runtime startup and CDP activation are explicit actions.

Requires Node.js 24. Run `npm test` for the package's offline tests.

A CDP command timeout produces `cdp-command-timeout` in `stateDirectory/events.jsonl`, recording the component, target, operation name, wait budget and actual elapsed time. Expressions and chat bodies stay out of that diagnostic. The record preserves the original timeout and command outcome.

```js
import { createPluginHost } from 'codex-toolkit-core';

const host = await createPluginHost({
  stateDirectory: '/absolute/dedicated/toolkit-state',
  plugins: [],
});
console.log(host.health());
await host.close();
```

A component declares `id`, `coreApiVersion: 1` and `start(context)`. Startup returns `close()` and may expose an asynchronous `check()`. The host supplies its `stateDirectory`, `log(entry)` and `setHealth({ ok, message })`. Only explicitly configured, installed components run. Component code has the current user's permissions.

## Shared CDP

Components requiring CDP declare `cdpPort: 'auto'` or an explicit port. Core combines the requirements, selects the port and passes the application launch arguments. Conflicting explicit ports fail before components start. CDP connections and debug arguments are created only when requested.

A component obtains its own access object with `await context.cdp.acquire({ signal })`. Core owns one browser WebSocket and target directory. Consumers read `targets()`, subscribe through `handlers` and call `send(method, params, sessionId?, timeoutMs?)`. Each component owns its attached sessions. `await client.close()` releases that component's sessions while other consumers remain connected. A component's abort signal cancels only its own startup wait.

Since Core 0.3.5, disconnection after application exit or update unregisters old targets and waits on the same port. Subscribe through `context.cdp.onReconnect(callback)`; the callback acquires access again and attaches its own sessions. Call the returned unsubscribe function on shutdown. Old access objects remain closed. Reconnection uses the 60-second startup wait for known connection refusals or resets; parsing, identity and unexpected errors are reported immediately.

Browser tracing has one owner at a time. The owner waits for its own `Tracing.tracingComplete` before releasing CDP. Closing a target or detaching a session cancels its pending commands with `CDP_TARGET_CLOSED`. Other protocol errors retain their original code, data and diagnostics. A browser-connection interruption requires reconnection through the component's check entry and remains an explicit error until recovered.

CDP connects on first use, allowing services to start before the application. Its initial connection uses a 60-second cold-start budget for a local listener that is still starting. Parsing, HTTP, identity and unexpected errors remain visible. Ordinary commands retain an 8-second budget. CDP has no password authentication and grants broad access; use it in a trusted local environment.

For native renderer-module access, import `createNativeAssetReader` and `loadNativeAppServices` from `codex-toolkit-core/renderer`. They locate loaded modules through the actual entry rather than a fixed build hash. Missing or ambiguous modules produce specific errors. Components inject these helpers only when needed.

`loadNativeConversationRpc(document, { assets })` returns the existing conversation RPC's `forHost(hostId)`. Discovery inspects available services and preserves existing conversation loading and history. Callers check the methods they actually use; an unread-badge interface is optional for discovery.

`readNativeConversationIdentity(document)` returns the visible main chat's `taskKey`, `threadId` and `hostId` for shared use. It reads the current conversation even with the sidebar hidden and retains cloud and remote identities. A Dot workspace with no verifiable chat identity returns `null`.

`readNativeNotification(data)` reads the current flat or legacy nested `mcp-notification` format, preserving the original parameters and event delivery. Invalid formats produce a specific error.

`createNativeBridgeClient(window)` owns native requests for one component. `request(message, responseType, requestId, timeoutMs?)` uses preload request/response messaging; `appServer(method, params, options?)` returns native app-server results. Remote errors retain their code, data and cause. Message listeners exist only while requests are pending. `close()` cancels that client's requests and releases its listeners.

`acquireFooter(document, owner, hostState)` shares a single footer and native-content height reservation. It returns `left`, `center`, `right`, `setHostState` and `release`. Components remove their own nodes before releasing the lease. The last release removes the footer, settings entry and layout styles. Settings use the same Core manager address and issue count across components.

`context.onHostState(listener)` delivers the shared manager address and host health and returns an unsubscribe function. The address appears once the local manager is ready. Unchanged health produces no duplicate notification, and host closure releases subscriptions. Listeners should update local state synchronously rather than wait for application or network startup. `setHealth` may provide `issueCount`; otherwise a failed component counts as 1 and a healthy one as 0.

Report `recoverable: false` through `setHealth` when reconnecting cannot repair an error. Core shows these errors immediately, keeps explicit checking available, and clears them after a healthy report. Renderer Kit errors use this mode. Kit health transitions are recorded as `kit-health-changed` in `stateDirectory/events.jsonl`, including the target page, execution context and original error.

## Windows launch entries

Requires standalone Node.js 24 and PowerShell 7. Use `pwsh.exe`; PowerShell 7 is the required baseline. In a PowerShell 7 terminal, call `node_modules/.bin/codex-toolkit.cmd` from the installation directory and copy the example configuration to `toolkit.json`. The component list starts empty and loads only explicitly listed installed components.

```powershell
./node_modules/.bin/codex-toolkit.cmd start ./toolkit.json
./node_modules/.bin/codex-toolkit.cmd status ./toolkit.json
./node_modules/.bin/codex-toolkit.cmd check ./toolkit.json
./node_modules/.bin/codex-toolkit.cmd launch ./toolkit.json
./node_modules/.bin/codex-toolkit.cmd stop ./toolkit.json
```

`start` runs in the background; `serve` uses the current terminal; `status` queries the current instance. `launch` uses the configured child-process environment and Codex's registered application alias. Fully exit Codex before launching a new instance. Existing working instances, user environment variables and login state are preserved.

If an installer has independently confirmed that all Codex application processes have exited, it may call `stop CONFIG.json --application-exited`. This releases a stale CDP connection before plugin cleanup instead of waiting for the exited application. Use it only after confirmed application exit: it ends the shared CDP connection while active browser tracing may still need flushing. Ordinary `stop` retains the normal cleanup order. Incomplete captures are reported as gaps, and unexpected cleanup errors remain visible.

If shared CDP is disconnected, `launch` makes one recovery attempt after opening the application so installed features can attach again, including after an earlier reconnection wait has expired. This recovery is separate from full component diagnostics, and specific feature errors remain in health.

`check` runs installed components' diagnostics while status remains queryable. Failures retain their specific errors and preserve the running application and proxy. Components with no check entry keep their existing health.

After a debug-command timeout, shared CDP rebuilds the connection once and notifies components to attach again. The original command or model request retains its outcome. A failed recovery stays visible; a new disconnection or explicit reconnect permits another recovery attempt. Page integrations share `initializePage(client, targetId, bindingName)` from `codex-toolkit-core/cdp`; failed initialization releases its session, while success registers it for UI synchronization.

Set a standalone PowerShell 7 location in `toolkit.json`, such as `"powershellPath": "C:/Program Files/PowerShell/7/pwsh.exe"`, then run:

```powershell
./node_modules/.bin/codex-toolkit.cmd prepare ./toolkit.json
```

This creates `start-toolkit.cmd`, `open-manager.cmd` and their PowerShell scripts beside the configuration. Double-click the first to start the service and Codex, or the second for the current local manager. Use the generated CMD entry for double-click launching. Entries owned by another installation or containing local edits are retained. A failed launch leaves a specific error visible until Enter is pressed; successful launch closes the terminal.

Use a stable, version-independent `powershellPath`. A Microsoft Store installation may use the current user's absolute `AppData/Local/Microsoft/WindowsApps/pwsh.exe` path. Versioned `WindowsApps/Microsoft.PowerShell_<version>/pwsh.exe` directories may be removed by updates. Any component-specific PowerShell path should use the same stable entry. Run `prepare` again after changing it.

The manager listens on loopback; `status` returns its current `managerUrl`. It lists installed component health and management pages. Its address contains a local access identifier, so keep it private. Use `open-manager.cmd` after an instance changes. The service validates local access and requires the management request identifier for operations.

A component may provide `management: { title, request({ method, url, body }) }`, returning `{ body, type?, status?, headers? }` or `null`. The host passes relative `/plugins/<id>/` requests to that component through the shared local HTTP service and its access checks. Only installed components have management routes.

A management page requiring updates can return `{ subscribe(listener) }`, send JSON state and return an unsubscribe function. Core exposes SSE through the same protected local service and releases subscriptions when the connection or manager closes.

One service owns a state directory. A Windows named pipe holds that ownership and releases it on process exit; stale PID files leave unrelated processes intact. Control commands use a per-run local token. `runtime-stderr.log` contains background errors, `events.jsonl` contains component events, and each application-launch helper writes errors to `launch-*/stderr.log`.

`stop` closes Toolkit components and services while leaving Codex open. If Codex is using the bandwidth proxy, exit the application before stopping its connection. Stop the old service before changing configuration.

## Upgrade and remove

Fully exit the Codex instance launched through the Toolkit, call `stop` and confirm service exit. Install matching Core and component archives with strict peer-dependency checking in the same installation. Retain `toolkit.json`, state and lockfiles. Certificates and uploaded image references belong to their original machine. Upgrades are explicit; Codex retains its official updater.

To stop using the Toolkit, exit the application and service, then open Codex through its native entry. Toolkit-specific environment settings belong to launched child processes. Logs and configuration are retained by default. Remove installed component rules or Hooks using their own removal commands.

After removal, the dedicated installation directory can be deleted. If state is stored inside it, first back up the configuration, logs and cache to retain. Keep the Codex home and other projects intact.

Tests use isolated temporary directories rather than existing Codex configuration, credentials or chats. The supported deployment target is Windows x64.
