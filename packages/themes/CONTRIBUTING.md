# Source checks

English | [简体中文](CONTRIBUTING.zh-CN.md)

Use standalone Node.js 24 and a matching local Core archive. Installation scripts are disabled by default; this component has no additional third-party runtime dependencies.

```powershell
npm install --no-save --package-lock=false --strict-peer-deps --ignore-scripts CORE_TGZ
npm test
node test/browser-smoke.mjs 'EDGE_EXECUTABLE'
```

Pass the absolute path of an installed Edge executable. Browser checks use a dedicated headless profile and local synthetic pages, keeping login data, real conversations and normal browser profiles outside the test. They cover actual DOM/CSS, native messages with source=null, asynchronous metadata and navigation races. Full integration with a specific Codex version requires separate evidence. Reports and browser profiles remain in Temp and stay out of packages.

For actual client integration, record the application version and main-window and secondary-window results separately. Keep read-only interface discovery, synthetic-browser checks and fresh-installation checks distinct. Preserve other conversations, real color settings and model-request activity during verification. Obtain user authorization before changing an active installation.
