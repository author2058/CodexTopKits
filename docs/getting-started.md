# Get started

English | [简体中文](getting-started.zh-CN.md)

Set up CodexTopKits from a source checkout on Windows x64, starting with the footer, settings button and table styling.

## 1. Prepare the environment

Install the Codex desktop app, Node.js 24 or later with npm, and PowerShell 7. Clone or extract this repository, open PowerShell 7 in its root directory and install dependencies:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
```

## 2. Prepare a local installation

Run these commands from the repository root:

```powershell
$destination = [IO.Path]::GetFullPath('./state/local')
New-Item -ItemType Directory -Path ./state -Force | Out-Null
node tools/prepare-source-install.mjs --destination $destination --node (Get-Command node.exe).Source --powershell (Get-Command pwsh.exe).Source --kit footer --kit manager-entry --kit table-style
```

Choose a new or empty installation directory. The installer builds the selected Kits and their dependencies, installs the required workspace modules, generates `toolkit.json` and prepares the launch entries. npm uses the dependency cache populated in step 1. Each Kit retains its own version and update selection.

For a first installation with more features, add a `--kit ID` argument for each Kit before running the command. The installer configures its shared services and required module handoffs. Selecting `ui-font-size` or `project-thread-colors` includes the **Themes** settings page. Selecting `awake-bridge` includes its keep-awake scripts.

`image-policy-rules` and `context-recovery-integration` also require `--codex-home` with the absolute Codex configuration directory. For example:

```powershell
$codexDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
node tools/prepare-source-install.mjs --destination $destination --node (Get-Command node.exe).Source --powershell (Get-Command pwsh.exe).Source --codex-home $codexDirectory --kit footer --kit manager-entry --kit image-policy-rules --kit image-reference-dedup --kit traffic-observer --kit context-recovery-integration --kit awake-bridge --kit ui-font-size --kit project-thread-colors
```

Choose either example for the empty directory. `--npm` accepts an absolute `npm-cli.js` path when npm is installed separately from Node. Installed code, settings, Kit artifacts and runtime state remain under the destination; keep that directory at a stable path. `agent-model-protection` is opt-in: add its ID only when its v1 child-chat workflow is needed.

## 3. Open the manager and Codex

```powershell
./state/local/open-manager.cmd
```

The manager's **Kits** page shows the selected versions. Quit Codex normally, then open:

```powershell
./state/local/start-toolkit.cmd
```

Codex opens with the selected Kits. The footer's settings button opens the current manager address; `open-manager.cmd` also finds that address each time. The launch entry waits for an exiting Codex process to finish before opening the application.

## Add, disable or update a Kit

1. Choose a Kit from the [catalog](../README.md#kits), read its prerequisites and build its `index.mjs`: `node packages/core/src/feature-pack.mjs packages/<module>/kits/<kit>/index.mjs Temp/kits`. Create `Temp/kits` first. Use a new build directory for an artifact already built at the same version.
2. In **Kits**, enter its absolute artifact folder under **Local Kit folder**, then click **Prepare local installation**. Add any required Kits as well.
3. Set **Run after restart** for the Kits to enable, then click **Restart Kit host**. Codex and its model connection stay open while the selected features reload.
4. For an existing Kit's new version, enter its artifact folder in that Kit's row and click **Prepare local update**, then restart the Kit host.

New source installations use `author2058/CodexTopKits` as their GitHub update repository. No token is required for a public repository. The manager checks the repository only when **Check for updates** is selected, then lists individual Kits from its `kits` release. Choose the updates to prepare, then restart the Kit host. To use another trusted catalog, add `--update-repository owner/repository` to the source installation command. See [catalog configuration](../packages/core/docs/features.md#restartable-kit-host) for private repository authentication and package details.

### Kits with shared services

The source installer configures services for the selected Kits. When adding a Kit later, its README lists the required module and service settings. Configure services in the same `options` object as `artifacts` before starting the Toolkit. For example, message labels use `chat-history`, while timer and scroll tools use `chat-diagnostics`:

```json
{
  "module": "codex-toolkit-core/kit-runtime",
  "options": {
    "cdpPort": "auto",
    "artifacts": ["C:/CodexTopKits/Temp/kits/message-labels-0.1.4"],
    "services": {
      "chat-history": { "module": "codex-toolkit-chat/history-service" },
      "chat-diagnostics": { "module": "codex-toolkit-chat/diagnostic-service" }
    }
  }
}
```

Replace example paths with actual absolute paths and include every Kit to load. Services accept additional settings in an `options` object beside `module`. A service configuration change takes effect after restarting the complete Toolkit: save current work, quit Codex, stop the Toolkit, then use the launch entry again.

```powershell
node state/local/node_modules/codex-toolkit-core/src/cli.mjs stop ./state/local/toolkit.json --application-exited
./state/local/start-toolkit.cmd
```

## Settings and safety

- Kit code runs with the current user's file and network permissions. Select trusted sources and review requested Hook installations.
- `cdpPort: "auto"` opens a randomly selected loopback debugging port with privileged access to Codex. Keep access limited to trusted local software.
- Settings, logs and collected diagnostics stay under the configured `stateDirectory`. Share sanitized extracts when requesting help.
- The manager's language setting offers automatic host-language selection, English and Simplified Chinese.
- A changed Hook may need approval in Codex's **Settings → Hooks** and a fresh Codex session to load it; use its status display to check activation.

The [app-restart Kit](../packages/core/kits/app-restart/README.md) adds **File → Restart with CodexTopKits** with a 20-second confirmation countdown. Use the [Kit API guide](../packages/core/docs/features.md) to build and package additional Kits.
