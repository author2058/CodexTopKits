# CodexTopKits — Traffic

English | [简体中文](README.zh-CN.md)

Traffic provides image-format guidance, uploaded image reference reuse and local traffic measurement for Codex, using the shared [Core](../core/README.md) infrastructure. The package imports as `codex-bandwidth`.

The package is licensed under [Apache-2.0](LICENSE). Third-party licenses are listed in [THIRD-PARTY.md](THIRD-PARTY.md). See the [installation guide](../../docs/getting-started.md) and individual [traffic Kits](../../README.md#image-bandwidth-and-traffic).

## Capabilities and requirements

Traffic uses the independently installed Core package and its declared dependencies. Appearance, toolbar, voice and window integrations are provided by their respective modules.

- Image formats: qualitative observation uses original-size WebP85, with JPG90 for verified native re-encoding cases. Lossless use retains PNG.
- Observation copies of existing PNG files: a separate file is created under the project's `Temp` directory, preserving the source and dimensions. Copies carry source paths and timestamps in metadata; inspect that metadata before sharing.
- Image-reference reuse: cache identity uses image content and the native account credential scope rather than a filename that may be overwritten. Once a reference is 7×24 hours old, that image is uploaded again and its cached reference refreshed only when a model request uses it. Other images retain their cache state.
- HTTP/WebSocket forwarding and model-transport measurement preserve native request semantics, cancellation, compression and errors.
- Traffic storage and incremental imports maintain one SQLite writer and keep measurement layers distinct.

Requires standalone Node.js 24, PowerShell 7, and the declared Sharp and ws dependencies. On Windows, PowerShell/.NET creates application-specific certificates while leaving the system certificate store unchanged. `powershellPath` selects the executable. Existing OpenSSL installations can explicitly configure `opensslPath`; execution errors are reported instead of switching certificate tools.

`npm run test:pure` runs offline tests that use neither Sharp nor ws. Once dependencies are installed, `npm test` also covers image conversion and local loopback HTTP/WebSocket behavior. These tests use local services.

## Install

Prepare Core and the selected Kits using the [installation guide](../../docs/getting-started.md). Application launch, route activation and Hook installation are separate explicit actions.

Copy this package's `toolkit.example.json` to the installation's `toolkit.json` and use Core's `start`, `status` and `launch` commands. Fully exit Codex before `launch`. The default configuration works independently of CDP. Initial status indicates that forwarding is ready and the native route is awaiting verification; it becomes observed forwarding only after an actual model request. Logs contain the image-reference and measurement results.

Set the standalone PowerShell 7 `powershellPath` in the configuration and use the same path in this component's `options.powershellPath`. Run `codex-toolkit prepare ./toolkit.json` to generate double-click entries, then use `start-toolkit.cmd` for the application and `open-manager.cmd` for the current manager. The configuration is local to this installation; system PATH, certificate trust and Codex login are preserved.

## Install image rules

Run the following only when changes to the selected Codex configuration are intended. Both directories must be absolute paths. `BANDWIDTH_STATE` is `plugins/bandwidth` under the configured Toolkit state root:

```powershell
./node_modules/.bin/codex-bandwidth.cmd install-rules 'CODEX_HOME' 'BANDWIDTH_STATE'
./node_modules/.bin/codex-bandwidth.cmd rules-status 'CODEX_HOME' 'BANDWIDTH_STATE'
```

The installer merges one local `view_image` Hook and installs the `codex-bandwidth-images` skill, preserving other Hooks, AGENTS.md and trust state. It records file ownership and backs up hooks.json before editing. Repeated installation keeps one entry; local edits or a similar Hook owned by another installation produce a conflict. Registration and runtime execution are separate states. Codex requires native trust approval for new or changed Hooks; inspect and approve them through the native `/hooks` interface. Activation follows the current client's configuration-loading behavior. See the [official Hook documentation](https://learn.chatgpt.com/docs/hooks).

The Hook inspects actual encoding and records metadata. Image conversion, image payload storage and network requests are outside that Hook's operation. The skill documents image-production and consumption conventions; [COVERAGE.md](COVERAGE.md) describes the supported tools. Keep installed state separate from source. Register the rules and approve the Hook again after changing installation paths.

To remove the rules, use the same directories:

```powershell
./node_modules/.bin/codex-bandwidth.cmd remove-rules 'CODEX_HOME' 'BANDWIDTH_STATE'
```

Removal targets only this installation's registered Hook and unmodified skill files. Backups, logs, image cache, native trust and unrelated configuration are retained. Locally edited skills or Hooks produce a conflict before removal.

## View traffic and enable optional capture

**Bandwidth and traffic** in the manager shows the time range, per-chat model measurements, first image uploads, cache reuse, request categories and capture gaps. Query results can be downloaded as JSON. The page uses this component's single SQLite writer and reports each measurement layer separately. Its existing typography and colors are retained; it refreshes every 10 seconds only while visible and following live data.

Optional component settings:

- `"cdpPort": "auto"`: select a local port, pass debugging arguments when the Toolkit launches Codex, and connect Chromium capture after application requests are observed. An explicit port is also accepted. Enabling this requires fully exiting and reopening Codex through the Toolkit. CDP grants broad application access and has no password authentication; use it in a trusted local environment. Image references and per-chat model measurements also work independently of Chromium capture.
- `"connections": true`: read a Windows process-connection snapshot every 30 seconds using ordinary permissions. This source reports connections rather than byte totals.
- `"windowsDirectory": "ABSOLUTE_DIRECTORY"`: incrementally import an independently started Windows ETW collector's output. Starting or elevating that collector is an explicit action.
- `"codexHome": "ABSOLUTE_CODEX_HOME"`: read the installed image-rule status for that Codex home. File changes and native trust remain separate actions.

Chromium capture uses Core's public CDP interface. When used with Themes or other components, Core owns the shared port, browser connection and target directory. Capture uses its own sessions; pausing or stopping releases only its own tracing. A connection interruption is reported as a gap, and a Toolkit check can reconnect it.

For Windows process-level byte comparison, configure `windowsDirectory`, restart the Toolkit service normally, then explicitly run the collector in PowerShell 7. Obtain `TOOLKIT_PID` from Core's `status` response:

```powershell
& 'POWERSHELL7' -NoProfile -File './node_modules/codex-bandwidth/src/traffic-windows.ps1' -OutputDirectory 'WINDOWS_DIRECTORY' -ToolkitProcessId TOOLKIT_PID -PowerShellPath 'POWERSHELL7' -Elevate
```

This requests Windows administrator confirmation. The collector records network-event metadata and leaves payloads encrypted. An existing collector holding the same resource prevents duplicate capture. Create an empty `stop` file in the output directory to release its ETW session. `-SelfTest` checks decoding and ownership using ordinary permissions, with live capture disabled. Permission failures, changed system events and lost events appear as errors or gaps.

## Native image-policy checks

Enabled Chromium capture resumes after the shared CDP connection recovers and clears its current connection error on success. Historical diagnostics are retained, and manually paused application-byte capture stays paused. Disconnected periods remain gaps; model requests are sent only through the normal request path.

On the first model request or a new native-version identifier, Traffic checks the actual Codex executable used by the desktop client in the background. It uses locally generated synthetic images, isolated temporary state and a loopback model service. Business images, login files and existing chats stay outside that check. Reports remain on each machine; synthetic test images and Codex executables stay out of distributed packages.

Checks cover dimensions, encoding and original bytes for unscaled `high`, `original` and compiled-default image handling. Results are reused for the same executable identity and policy version. Run `codex-toolkit check ./toolkit.json` to request a fresh check. Results are stored in `native-policy/native-policy-check.json` under this component's state directory, alongside detailed synthetic-test records.

Application startup and model forwarding continue while the check runs. Policy mismatches, failed executable discovery and missing version identifiers appear in Core health until the relevant check succeeds. A missing version identifier continues to indicate that automatic update checks are unavailable even after a manual check. Stopping the service cancels only its own test processes. Each isolated test group has a 60-second execution budget, separate from application startup timing.

For source tests, install locked dependencies with `npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund --registry https://registry.npmjs.org`, install a matching local Core archive with `npm install --no-save --package-lock=false --strict-peer-deps --ignore-scripts CORE_TGZ`, then run `npm test`. Keep formal cross-package installation and compatibility checks separate from source-workspace preparation.

`test/package-smoke.mjs` accepts an isolated installation directory. A third argument of `native` uses the default PowerShell certificate path; an existing OpenSSL path can be supplied instead. It checks package imports, image conversion, isolated certificates, background start/stop and lifecycle using local services.

The forwarding proxy can access native authentication, text and images that pass through it. Default logs retain metadata and exclude request bodies and authentication headers. File references use non-public Codex integration points, so future client changes may require an update.

Seven days is the local cache-refresh policy; server-side reference validity may differ. References are reused until their local refresh point. A failed refresh is reported for the affected image; other images keep their existing state. Early server revocation can still produce file-reference errors.

## Upgrade and disable

Fully exit Codex instances using the proxy, call Core's `stop` and confirm that the service has stopped before replacing installed files. Install compatible Core and Traffic versions in the original directory, retaining configuration, lockfiles and state. Routing and Hook activation remain separate from package installation and imports.

To disable Traffic, remove its installed rules, exit the application and stop the service, then open Codex through its native entry. Toolkit-specific environment settings belong to its launched child processes. Data and test installations are retained for explicit cleanup.

Assess logical-byte, application and network measurements separately when comparing provider traffic charges.
