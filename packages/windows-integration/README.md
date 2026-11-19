# CodexTopKits — Windows Integration

English | [简体中文](README.zh-CN.md)

Windows Integration adds window tabs, scheduled sleep, Markdown read-aloud and update-restart protection to Codex on Windows x64. It requires [Core](../core/README.md) 0.3.16 or a compatible later version and can be installed independently. See the [installation guide](../../docs/getting-started.md) and individual [desktop Kits](../../README.md#toolbar-and-desktop).

## Use

Requires Windows, Node.js 24 or newer and PowerShell 7. Install this package and Core in the same dedicated directory, then add the component entry from `toolkit.example.json` to Core's configuration. If PowerShell is outside PATH, specify its absolute `powershellPath` in the component options. Start Codex through Core or use the same already-open local CDP port.

The toolbar shows open windows as flat centered tabs. Clicking a tab switches to that window and preserves its maximized state. Each tab uses an independent system identity to match its actual window and process. Chat changes update the label; running status takes priority over completed-unread status. Unread states from before initial activation are outside the observed event history. Newly created windows are ordered by creation; pre-existing windows use discovery order. Unverified window identity produces a specific error.

The moon starts disabled. When enabled, the component waits until all local chats have finished and remained idle for one minute, then queries native chat status. Once it confirms that every chat is idle, it disables the moon in all windows and requests Windows sleep. A new turn cancels pending sleep. Sleep and wake events both disable the switch.

The settings entry opens Core's shared manager. A red count indicates current issues, with details on the page. The component uses the logged-in desktop user's normal permissions and preserves installed Codex files, system volume, startup entries and power plans. CDP can control the application and read conversation data; grant access only to trusted local programs.

The native context menus for Markdown chat links and file-browser entries gain **Open in Microsoft Edge and read aloud**. This opens a normal Edge window, sets 200% zoom, confirms that the window is in the foreground and starts native Read aloud. It checks for the playing state's pause button. The action changes the foreground window; a denied focus change or unconfirmed playback appears as a specific manager error. Other file types and native menu actions retain their behavior.

The official update button retains Codex's installation method. This component protects the native updater's Windows restart arguments inside the current official main process so that its restart keeps the local CDP arguments. Version selection, downloads, installation and other restart arguments and flags remain native. A green dot appears only after the hook and registered arguments have been read back successfully; failures appear in the manager. Protection lasts for that Codex process and keeps installed files unchanged. Security software may block this in-process operation.

Window-layout restoration remains disabled; window opening and placement stay under user control.

The toolbar always offers **Clear cloud unread**. It clears the cloud unread state confirmed by the native interface and preserves local chats. Dot workspaces participate in window switching, synchronize their titles and retain their cloud identity.

For an existing Codex Awake script, set the component's `awakeScript` to the absolute path of `Update-CodexAwakeState.ps1`. Native turn-start and completion events are forwarded, and loaded chats are reconciled every 30 seconds to close wake holds after cancelled or failed turns. Existing global Awake Hooks are preserved. Leave the option unset when that script is unavailable. See the independently managed [awake-bridge Kit](kits/awake-bridge/README.md).

## Development

`npm test` runs automated checks. Sleep tests use injected clocks and simulated actions. `node test/browser-smoke.mjs <Edge executable path>` checks controls, styling and cleanup in a dedicated headless browser profile. Real window switching requires an authorized dedicated Codex instance.

`pwsh -NoProfile -File test/set-codex-restart.test.ps1` checks x64 protection in a test process. Only pass a real PID when explicitly inspecting protection already installed in that process.

The package is licensed under [Apache-2.0](LICENSE).
