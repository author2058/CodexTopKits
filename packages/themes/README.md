# CodexTopKits — Themes

English | [简体中文](README.zh-CN.md)

Themes provides project and chat colors for Codex through [Core](../core/README.md). Its package name is `codex-toolkit-themes`, licensed under [Apache-2.0](LICENSE). See the individual [appearance Kits](../../README.md#appearance).

The component provides 12 hue presets and dark-gray neutral, project colors, per-chat overrides or inheritance, four global color-category switches, and an 11–24 px UI font-size override. Each manager entry displays its representative color. **Native** removes the theme colors; **Inherit** follows the project. Font size is a separate global setting, preserving editor and code-font variables.

Themes targets the main Codex interface. Right-side chats keep their native colors, and pet and voice-overlay windows keep their own backgrounds and font size. Toolbar, output labels, voice and Windows actions are managed by their respective components.

## Install and start

Requires Windows x64, standalone Node.js 24 and PowerShell 7. Prepare Core using the [installation guide](../../docs/getting-started.md), then select the appearance Kits to use.

Start with this package's `toolkit.example.json`, set a standalone `powershellPath`, and run Core's `prepare` to generate launch and management entries. Fully exit Codex, then use `start-toolkit.cmd`. Open `open-manager.cmd` and select **Themes and appearance**.

Themes uses CDP. `cdpPort` defaults to `auto`; Core assigns a local port and shares the browser connection and target directory among components. A fixed port can be specified consistently in the options. CDP grants broad application access and has no password authentication, so use it in a trusted local environment. The Toolkit uses loopback connections and listeners.

Installing or importing the package and changing theme settings preserve a running Codex session. Initial CDP enablement takes effect after fully exiting and reopening the application; later color and font-size changes are distributed immediately.

## Configuration and compatibility

The default color map is `plugins/themes/theme-map.json` under the Toolkit state directory. An absolute `mapPath` option can select another file. Missing configuration creates the built-in presets; an existing file that fails parsing is retained and produces a specific error. Project names, chat IDs and custom colors stay in the installation's local state.

Project identity primarily comes from native project IDs, directories and conversation metadata, with the sidebar as a supplemental source. Window creation, navigation, closure, project notifications and configuration-file changes trigger updates. The manager uses Core's local event stream; hidden pages unsubscribe, and background updates retain open color controls.

**Check interfaces** inspects the current main window again. After a client update, changes to modules, project metadata, the message bridge or DOM interfaces appear as concrete errors in the manager and Core health. An incompatible integration reports its problem. If a previous theme controller still owns the page, stop that controller before enabling this module.

## Upgrade and remove

Fully exit the Codex instance started through the Toolkit, stop Core and confirm that the service has exited before replacing program files. Install compatible versions and retain configuration and state. Codex updates continue through its official updater.

To remove Themes alone, stop the Toolkit and remove its entry from the `plugins` list. Stopping removes this component's styles, subscriptions, early-injection scripts and CDP sessions, while retaining personal colors and other components' browser tracing. To close the application's debug port when CDP features are no longer needed, fully exit Codex and reopen it through its native entry.

## Compatibility limits

Themes relies on Codex's internal interfaces. A client update may interrupt color application or project detection; the manager shows the specific problem. Themes can be disabled while retaining other components. The integration reports incompatible interfaces while keeping installed Codex files unchanged.
