# Kits

A module can maintain several independently versioned Kits. A Kit is not an entire repository, an npm package, or a process. The existing aggregate module entry points remain available while individual Kits are extracted.

## Manifest and dependencies

Each Kit directory under `kits/` contains an `index.mjs` definition and `kit.json`:

```json
{
  "id": "weekly-usage",
  "version": "0.1.2",
  "entry": "index.mjs",
  "coreApiVersion": 1,
  "dependencies": { "footer": "^0.1.1" }
}
```

Each Kit has its own version, independent of its module's npm package version. `coreApiVersion` identifies the renderer lifecycle contract. Core 0.3.16 or later supports exact versions and caret ranges such as `^0.1.1`; other range syntax and prerelease versions are not supported. Missing dependencies, incompatible versions, duplicate IDs and dependency cycles are rejected before a Kit starts.

An optional `license` field records the Kit's license identifier. The packer includes a Kit-local `LICENSE` and `NOTICE` when present. With an explicit license matching the nearest containing npm package, it can use that package's legal files; Kit-local files take precedence. These files become declared assets and travel with independent Kit update bundles. A different containing-package license is not inherited. The packed manifest requires at least Core 0.3.21 for asset support.

From Core 0.3.37, `defaultEnabled: false` keeps a Kit disabled on first discovery or installation. Omit the field to retain the usual enabled default. Explicit configuration and saved user selections take precedence; updating a Kit never resets its existing selection. The Kits page can enable an opt-in Kit normally.

When a Kit needs a newer Core implementation, its manifest can declare `minimumCoreVersion`, such as `0.3.19`. Core 0.3.19 and later reject unsupported or malformed minimum versions before loading an artifact. Kits that require this behavior also check their needed capability when run by an older Core.

Core 0.3.22 checks optional `serviceVersions` against each declared service module's exported `serviceApiVersion` before stopping the running Kit host. Exact and caret ranges follow the same rules as Kit dependencies. A service version describes its integration API, not its npm package version. Existing artifacts without `serviceVersions` remain compatible but do not receive this check.

From Core 0.3.23, newly packed Kits that declare `serviceVersions` must declare Core 0.3.23 or later and refuse to start when an older or unverified host cannot confirm that check. The normal Kit runtime performs the check; callers of the lower-level host or payload API must verify service versions themselves before passing `serviceVersionChecks: true`. Previously packed artifacts are unchanged.

The module's default export is `{ manifest, create, helpers? }`. `create(context, helpers)` returns an object with `close()`. The factory and helpers must be self-contained function or arrow expressions; object-method shorthand cannot be packed. Generated modules contain only that Kit and its helpers; dependent Kits remain separate artifacts. A third-party Kit may live in a separate repository and use the same manifest and packer contract.

## Lifecycle

```js
import { createKitHost } from 'codex-toolkit-core/kits';
import footer from 'codex-toolkit-core/kits/footer';
import weeklyUsage from 'codex-toolkit-chat/kits/weekly-usage';

const host = createKitHost([footer, weeklyUsage], { document });
await host.start('weekly-usage'); // Starts footer first, but no other features.
await host.stop('weekly-usage'); // Leaves footer and other consumers in place.
await host.close();
```

The context provides `document`, declared dependency APIs, `getHostState()`, `onDomChange(callback)` and `reportError(error)`. Register at most one DOM refresh callback per feature. The host shares a single child-list observer, coalesces native DOM changes, and ignores mutations inside nodes marked `data-cdtk-owned`. A feature must mark only its own nodes, never a native container. Features remove their own nodes, subscriptions and timers in `close()`; the host also removes their DOM-refresh subscription. Original error names, messages and stacks remain available in `snapshot()`.

`setHostState(value)` supplies the current manager address and shared health information. Stopping a dependency while an active or starting dependent requires it is rejected. `close()` stops features in reverse dependency order. A feature that cannot close reports its error instead of pretending its resources have been released.

Updated: 2026-11-19 00:23 (Asia/Taipei). Core 0.3.39 adds `context.i18n` with shared language selection and event-driven updates; each Kit retains its own dictionary and artifact. See the [localization contract](localization.md) for persistence, environment precedence and lifecycle rules.

`featurePayload(definitions, options?)` builds one renderer payload for an explicitly selected dependency set. Its host is available as `window.__CODEXTOPKITS_FEATURE_HOST__`. A second host cannot replace the existing owner. Close the first host and delete that global only after successful cleanup before installing a new payload. No function in this API connects to Codex, sends model requests or restarts the application by itself.

## Independent artifacts

Run the packer with a trusted source entry and an existing output directory:

```powershell
codextopkits-kit-pack ./kits/footer/index.mjs ./Temp
```

The packer creates `Temp/footer-0.1.3/` containing `kit.json` and a self-contained `index.mjs`. It refuses to overwrite an existing artifact. The packer imports and executes the source module with the current user's permissions; use only trusted local code. `kitModule(definition)` exposes the same compilation operation without filesystem access. Core 0.3.17 normalizes line endings in generated code, so the checkout's line-ending setting alone does not change the artifact.

To prepare a GitHub release asset from an already packed Kit, run:

```powershell
codextopkits-kit-bundle ./Temp/footer-0.1.3 ./Temp
```

The command creates `footer-v0.1.3.kit.gz` and prints its SHA256. It includes the Kit's manifest, entry, optional backend and declared assets, and refuses to overwrite an existing bundle. Place versioned bundles in a GitHub release tagged `kits`; the shared release is an asset collection, not a shared Kit version. Existing assets for other Kits need not change.

For an existing `kits` release, upload one new asset without replacing previous versions:

```powershell
gh release upload kits ./Temp/footer-v0.1.3.kit.gz --repo owner/repository
```

Core 0.3.20 also supports an optional self-contained `backend.mjs` in a Kit artifact. The manager checks its syntax before preparing the update, and the Kit's service receives the selected artifact's path when the host restarts. The service owns the handoff of in-flight work; a backend is trusted local code and is not a sandbox.

Core 0.3.21 allows a Kit to declare its additional files in `assets`. The packer and manager keep those files together with the versioned backend; paths are relative to the artifact and cannot escape it.

The available footer Kits are `footer@0.1.3` and `manager-entry@0.1.1` in Core; `weekly-usage@0.1.3` and `scheduled-reset-marker@0.1.4` in Chat Enhancements; and `window-tabs@0.1.7`, `auto-sleep@0.1.5` and `cloud-mark-read@0.1.3` in Windows Integration. The footer exposes left, flexible center and right slots to its consumers. Each artifact contains only the selected Kit and its own helpers.

## Restartable Kit host

Core 0.3.16 exports `codex-toolkit-core/kit-runtime`, a normal toolkit module that owns the stable CDP lease and starts a separate Kit-loader process. The loader imports installed Kit artifacts and builds renderer code. DOM lifecycles run in the Codex renderer, while artifact loading and its module cache live in the loader process. Restarting the Kit host closes only its owned renderer Kits, replaces that child process and reloads selected artifacts. The stable toolkit process, shared CDP connection, native Codex page and model-transport modules remain open. The loader is not a security sandbox.

Add the feature runtime to `toolkit.json`, using already built artifacts:

```json
{
    "module": "codex-toolkit-core/kit-runtime",
  "options": {
    "artifacts": [
      "C:/CodexTopKits/artifacts/footer-0.1.3",
      "C:/CodexTopKits/artifacts/manager-entry-0.1.1",
      "C:/CodexTopKits/artifacts/weekly-usage-0.1.3"
    ]
  }
}
```

The runtime's **Kits** management page lists each Kit's running version, next-start selection and prepared version. Change **Run after restart** or enter a trusted local update folder and click **Prepare local update**, then click **Restart Kit host**. From Core 0.3.28, **Prepare local installation** also adds a trusted packed Kit that is not already installed. Install and select its required Kits separately; any services it needs must already be configured. Dependency and service validation happens before stopping the current host. Invalid selections leave the current host running. Preparing an installation or update copies its manifest, entry, optional backend and assets into versioned local storage; it does not execute the candidate. Restarting loads only the chosen version of each Kit, and the successful selection and manager-installed Kits survive the next normal toolkit start. Other installed versions remain unchanged. A module-load failure is reported, without silently activating an older version.

To enable on-demand GitHub updates, add `"githubUpdates": { "repository": "owner/repository" }` to the Kit runtime's `options`. The manager checks that repository's `kits` release only when **Check for updates** is clicked, and offers a separate **Prepare available update** action for each installed Kit. From Core 0.3.28 it also lists Kits that are not yet installed and offers **Prepare installation** for each one. Only the selected bundle is downloaded. The manager verifies the GitHub asset size and SHA256, the Kit ID, version and declared paths, then uses the same preparation and host-restart workflow as a local artifact. This is not a general marketplace or a signature verification system: install Kits only from a repository whose maintainers are trusted, because Kit code runs with the current user's permissions.

One Kit runtime currently checks one configured GitHub repository. Kits from other repositories can still be installed and updated using their local artifacts and the same Kit contract.

Public repositories need no GitHub token. For a private repository, enter a token with read access to that repository's Contents in the manager, or provide `CODEXTOPKITS_GITHUB_TOKEN` when starting Toolkit. The manager does not write the token to its configuration or logs; a token entered in the manager remains in Toolkit process memory until Toolkit stops. The token is sent only to `api.github.com`, not to the redirected release-asset host. HTTPS requests use the system's trusted certificate authorities and configured proxy environment. A proxy trusted to intercept HTTPS can read the token as well.

Core 0.3.18 checks every connected page before stopping any Kit for a host restart. A Kit may provide `beforeRestart()` when an in-progress operation cannot safely be reattached. If a check fails, the current host stays running and the reason is shown. The `voice-volume` Kit uses this to defer host restart while a voice call is active.

For compatibility, the old `features`, `feature-runtime`, `plugins/<id>` and `codex-toolkit-feature-pack` entry points remain aliases. The loader also accepts existing artifacts with `plugin.json`; if `kit.json` is present but invalid, it reports the error instead of falling back. The host configuration's existing `plugins` field and management routes are unchanged.

The runtime can become ready before Codex starts; connection waiting runs in the background through Core's shared CDP service. App connection loss reattaches the current selection without applying pending updates. Reconnecting does not start a second browser connection or activate a candidate silently.

## Shared feature services

Only Kits that declare a service start it. `window-tabs` and `auto-sleep` require `windows`; neither requires the other Kit. Configure `services.windows.module` as `codex-toolkit-windows/feature-service`. Its `options.powershellPath` accepts the standalone PowerShell 7 executable. The shared service owns the native window directory, identity-based focus and scheduled-sleep state. `scheduled-reset-marker` requires `scheduled-reset`, whose module is `codex-toolkit-chat/feature-service`; it reuses the existing ten-minute public forecast check. `rich-paste-boundary`, `composer-timer`, `scroll-handoff-fix` and `scroll-diagnostics` require `chat-diagnostics`, whose module is `codex-toolkit-chat/diagnostic-service`; it records paste metadata without clipboard text and the existing timer and scroll diagnostics. `cloud-mark-read` reads native cloud state directly and needs neither service.

`message-labels` requires `chat-history`, whose module is `codex-toolkit-chat/history-service`. It reads the local native history database without changing it and supplies identifiers, ordinals and timestamps for partially loaded completed turns. Its optional `options.codexHome` is an absolute path.

`ui-font-size` and `project-thread-colors` require `theme-settings`, whose module is `codex-toolkit-themes/feature-service`. With an existing Themes module, set `options.legacyPlugin` to `themes` to reuse its management page and settings. The color Kit reuses its existing native chat context without a second query. Without Themes, `options.mapPath` may specify an absolute settings file, and the color Kit reads the native chat context itself. The service watches the settings file for changes.

`markdown-edge-read-aloud` requires `read-aloud`, whose module is `codex-toolkit-windows/read-aloud-service`. Its `options.powershellPath` specifies PowerShell 7. The service uses the existing Markdown launcher when the user selects the menu action.

`update-restart-protection` requires the `restart-protection` service from `codex-toolkit-windows/restart-protection-service`. With Windows Integration, set `options.legacyPlugin` to `windows` to reuse its existing guard. Otherwise the service uses the active shared CDP port. The official update button remains unchanged, and the green indicator appears only after the guard is verified.

Service code runs in the stable toolkit process, outside the restartable loader. Updating a service or Core itself is a different operation from updating a renderer feature; do not restart the stable process while it carries model requests.

Services that do not use a CDP client can explicitly set `startBeforeCdp: true` in their service configuration. Core 0.3.25 starts those selected services before Codex connects and retains them across CDP reconnections; they must not depend on `context.cdp`. For an existing Bandwidth handoff, use this on `image-reference` and `traffic-observer` so image reuse and model traffic collection are ready before the application can send requests. Other services continue to wait for CDP. This does not change their Kit selection or wait for a remote service.

## Existing installations

To preserve aggregate features that have not been extracted, Chat supports the migration-only option `externalWeeklyUsage: true`, and Windows Integration supports `externalFooter: true`. These prevent their old footer UI from installing; their other existing features continue unchanged. Chat also accepts `externalKits` containing any separately managed `table-style`, `image-viewer-close`, `selection-actions-delay`, `file-line-highlight`, `rich-paste-boundary`, `context-meter`, `output-speed`, `composer-timer`, `live-model-output`, `message-labels`, `history-show-all`, `title-emoji`, `fast-mode-indicator` or `child-model-warning` Kit. Enable `composer-timer` separately when choosing `live-model-output`; when the legacy Chat module is present, hand off both of these to avoid a duplicate timer bar. These options do not enable the corresponding Kits. The legacy modules must precede the Kit runtime in `toolkit.json`. Add `options.legacyPlugin: "windows"` to the `windows` service, and `options.legacyPlugin: "chat"` to the `scheduled-reset` service. Those adapters reuse the legacy modules' existing native state, sleep monitor and forecast feed instead of starting duplicates. A fresh Kit-only installation does not need legacy modules or these options.

The optional `scroll-handoff-fix` and `scroll-diagnostics` Kits also support `externalKits` handoff. Both remain off unless explicitly selected; a migration does not enable either one.

Themes accepts `externalKits` containing `ui-font-size`, `project-thread-colors` and/or `profile-panel-shadow` to hand off those features while keeping its management page. Place Themes before the Kit runtime when using its shared settings owner.

For `voice-volume`, set the existing Voice Controls module's `externalKit` option to `true` and place it before the Kit runtime. The Kit owns the voice controls while the existing Voice management page keeps receiving their status; stopping the Kit does not remove that page. Without this handoff, the legacy module and the Kit must not both own the same controls.

Windows Integration accepts `externalKits` containing `markdown-edge-read-aloud` and/or `update-restart-protection` to hand off those features while preserving its other features.

For `agent-composer`, set Session Recovery's existing `restoreAgentComposer` option to `false` and place the Session module before the Kit runtime. The Kit retains the native compatibility and parent checks. It requires Core 0.3.18 or later and defers a host restart while a panel conversion is in progress. Session model protection remains independent.

For `agent-model-protection`, retain Session Recovery for its registry, management page and send-preparation endpoint, set its `externalKits` to `["agent-model-protection"]`, and place it before the Kit runtime. Configure the `session-runtime` service with `codex-toolkit-session/model-protection-service`. The Kit owns the renderer guard; a protected send cannot be prepared while the Kit is unavailable, and a host restart waits for an in-progress verification. This does not intercept callers that bypass the existing preparation workflow.

`agent-model-protection` is an opt-in compatibility Kit for explicitly protected v1 children. Version 0.1.3 defaults to disabled and requires Core 0.3.37. Session Recovery defaults to handing this guard to the Kit, so leaving it disabled does not activate an internal replacement. Existing enabled selections are preserved. Use Session Recovery's `unprotect` command to end an old protection registration before returning that target to ordinary send preparation. Review coordination has its own send-time settings check and does not require this Kit.

`awake-bridge` requires `windows` and `awake` services. Set `services.awake.module` to `codex-toolkit-windows/awake-service` and `services.awake.options.awakeScript` to the absolute path of the existing Awake script. With an existing Windows module, add `awake-bridge` to its `externalKits` and set `legacyPlugin: "windows"` on both services; the Awake service can reuse the script path from that module. The service keeps native activity delivery while it swaps Kit backends and finishes outstanding state writes first. It does not install the Awake script or initiate sleep.

`image-reference-dedup` uses the existing Bandwidth transport and its cache. Add this Kit to Bandwidth's `externalKits`, place Bandwidth before the Kit runtime, and configure `services.image-reference.module` as `codex-bandwidth/image-reference-service`. Existing requests finish their transformation and cache writes before a backend swap; requests entering during the swap wait locally, and existing model connections remain open. Disabling the Kit leaves requests unmodified while retaining traffic identification. The first installation of this stable transport handoff requires a coordinated Toolkit deployment; later Kit backend updates do not restart the transport.

`context-recovery-integration` uses Session Recovery's existing installation receipt and requires the `context-recovery` service from `codex-toolkit-session/context-recovery-service`. Supply absolute `codexHome`, standalone `nodeExecutable` and PowerShell 7 `powershell` paths in the service options. Updating the Kit updates its owned recovery files; disabling it removes only its compact Hook and retains the child-runtime skill and unrelated Hooks. Codex controls when it reloads Hooks and whether a changed Hook needs native trust confirmation; a Kit-host restart alone does not guarantee an already running chat has reloaded it.

`image-policy-rules` uses the `image-policy` service from `codex-bandwidth/image-policy-service`. Add the Kit to Bandwidth's `externalKits` and supply absolute `codexHome` and standalone `nodeExecutable` paths in the service options. The Kit updates its owned Skill and image-inspection Hook together with the matching native-policy checker. A changed policy clears the old check result and waits for the next native-version observation or an explicit check; it does not claim the old result verifies the new policy. A changed Hook command may require Codex's native trust confirmation and reload.

`traffic-observer` uses the `traffic-observer` service from `codex-bandwidth/traffic-observer-service`. Add it to Bandwidth's `externalKits`; the existing Bandwidth transport remains open. During an update, model-traffic metadata is queued in memory while the current collector closes and the new collector reuses the same database. Chromium tracing is reattached with its prior enabled or paused state, and a possible tracing gap is recorded. Data before the observer is first enabled is not collected. When the Kit is off, the traffic page reports that collection is disabled rather than showing an invented zero.

Do not enable a standalone footer consumer beside the same aggregate consumer without its migration option. Installing this runtime into an older stable toolkit may require a coordinated first deployment; per-feature host restart is not a way to update the older stable process itself.
