# Third-party dependencies and sources

This file lists dependencies and sources used by the Windows x64 distribution. CodexTopKits is licensed under [Apache-2.0](LICENSE); third-party components retain their own licenses.

| Component | Pinned version | Declared license | Purpose |
|---|---|---|---|
| [ws](https://github.com/websockets/ws) | 8.22.2 | MIT | HTTP upgrade, WebSocket forwarding and frame accounting |
| [Sharp](https://github.com/lovell/sharp) | 0.35.5 | Apache-2.0 | Original-size observation image encoding and XMP |
| `@img/sharp-win32-x64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | Installed Windows x64 native image codecs; preserve its bundled notices |
| `@img/colour` | 1.1.0 | MIT | Colour handling; its notice is `LICENSE.md` in the installed package |
| `detect-libc` | 2.1.2 | Apache-2.0 | Runtime detection |
| `semver` | 7.8.6 | ISC | Version comparison |
| Other platform-specific Sharp dependencies | Exact versions and integrity recorded in package-lock.json | See each installed package | Only Windows x64 is in the current verified distribution scope |
| PowerShell 7/.NET | User-installed executable | Check the installed distribution | Default Windows installation-local certificate generation and running desktop runtime discovery; no system trust-store writes |
| Codex native CLI | The desktop app's existing runtime | Not redistributed | Isolated loopback image-encoding conformance checks; no cloud model calls |
| OpenSSL | Optional user-installed executable | Check the installed distribution | Explicit compatibility option for existing certificate setups |
| [OpenAI Codex image preparation source](https://github.com/openai/codex/blob/rust-v0.166.0-alpha.6/codex-rs/utils/image/src/lib.rs) | rust-v0.166.0-alpha.6 | Apache-2.0, Copyright 2025 OpenAI | Dimension rounding adapted to JavaScript; source tag and modified-file notice retained, license copied to `third-party/openai-codex-LICENSE` |

Project archives contain project sources and their applicable licenses, while npm installs declared third-party packages separately with their original licenses and notices. Node, PowerShell, Codex and third-party codec binaries are not included in the project archives. Keep the installed dependencies' license and notice files. Registry URLs, versions and integrity values are pinned in [package-lock.json](package-lock.json). A distribution that includes third-party binaries must also account for the licenses and notices of those binaries.

## 简体中文

本文列出 Windows x64 分发使用的依赖与来源。CodexTopKits 使用 [Apache-2.0](LICENSE)，第三方组件保留各自的许可证。

项目归档包含项目源码及其适用许可证；npm 单独安装声明的第三方依赖，并保留依赖原有的许可证和声明。项目归档不包含 Node、PowerShell、Codex 或第三方编解码二进制文件。请保留安装依赖中的许可证和声明文件。[package-lock.json](package-lock.json) 锁定了仓库地址、版本和完整性值。若分发包含第三方二进制文件，还需处理这些文件各自的许可证和声明要求。
