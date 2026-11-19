# Image and traffic coverage

English | [简体中文](COVERAGE.zh-CN.md)

## Image production and consumption

| Entry | Package capability | Boundary |
|---|---|---|
| Tools producing observation images | Public format selector: qualitative WebP85, JPG90 when required, quantitative PNG | The producer must call the selector and support the encoding. Each screenshot tool retains its own integration. |
| Existing PNG used for qualitative model observation | Original-size UUID observation copy, retaining the original and source metadata | Only the explicitly supplied file is processed; project-wide scanning is outside this operation. |
| Local `view_image` | Native PreToolUse Hook checks the extension against actual encoding and records metadata | Requires native trust. Conversion is a separate action, and paths are interpreted on the local executor. |
| Supported image containers in model requests | HTTP/WebSocket reference reuse keyed by actual image content and account | Non-public integration may change with the client. Unknown containers produce an explicit error rather than silently repeating uploads. |
| MCP image results, Computer Use, generated images and other direct image-return tools | Bundled skill guidance to inspect the current path's format support | Binary handling belongs to each tool. WebP output requires an encoding option supported by that native tool. |
| Client image re-encoding | Three loopback checks of the native executable on the current machine | Uses synthetic images and local services. The effective model budget needs evidence beyond aspect ratio. |

Skills are discovered according to the task; loading on every turn is not guaranteed. Workflows requiring a reminder can reference `codex-bandwidth-images` in their own AGENTS.md. The installer preserves existing AGENTS.md files and trust state.

## Traffic measurement

| Source | Default | Observable data | Outside its coverage |
|---|---|---|---|
| Package model proxy | Enabled | Per-chat/connection model-transfer bytes, logical size, first image uploads and cache reuse | Traffic outside the proxy, TLS/TCP/IP and full file-API overhead, provider billing |
| Chromium/CDP | Disabled | Classification of pages, static assets, telemetry, realtime connections and attributable requests | Native codex.exe traffic outside Chromium; some worker sources may be invisible |
| Windows kernel ETW | Disabled | TCP/UDP sent and received bytes and remote endpoints for the target process tree | Encrypted contents and individual-chat attribution inside one native process; lost events limit total completeness |
| Windows connection snapshots | Disabled | Current TCP connections and UDP bindings, processes and endpoints | Byte counts, complete short-connection history and connection establishment times |

These sources may observe the same communication, so report them separately rather than adding their totals. The page distinguishes disabled collection, waiting, gaps and errors; missing data remains unknown. Default storage excludes prompts, image payloads, authentication headers, TLS keys and full requests.
