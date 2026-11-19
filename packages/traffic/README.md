# CodexTopKits — Traffic

Traffic provides image-format guidance, uploaded image reference reuse and local traffic measurement for Codex. The package imports as `codex-bandwidth` and requires [Core](../core/README.md). See the [installation guide](../../docs/getting-started.md), [traffic Kits](../../README.md#image-bandwidth-and-traffic) and [third-party licenses](THIRD-PARTY.md). The package is licensed under [Apache-2.0](LICENSE).

## 简体中文

CodexTopKits 的流量优化与计量组件，依赖 [Core](../core/README.md) 公共底座。本包的导入名仍为 `codex-bandwidth`。

本包使用 [Apache-2.0](LICENSE)，第三方组件的许可证见[依赖说明](THIRD-PARTY.md)。

本包依赖独立的 `codex-toolkit-core`，不包含主题、底栏、语音或窗口改造，也不从 Codex 私有缓存读取运行依赖。

已提取的能力包括：

- 图片格式选择：定性观察使用原尺寸 WebP85；已验证的原生重编码规则需要时使用 JPG90；无损用途保留 PNG。
- 已有 PNG 的观察副本：生成工程 `Temp` 下的独立文件，不改原图或尺寸；副本包含来源路径和时间，分享副本前应注意这些元数据。
- 图片引用去重：按内容和原生账户凭据作用域复用文件引用，不按可能被覆写的文件名复用。引用满 7×24 小时后，只在当前模型请求使用该图片时重新上传并缓存新引用；其他图片不受影响。
- HTTP／WebSocket 转发和模型传输计量：保持原生请求语义、取消、压缩和错误行为。
- 流量存储及增量导入模块：保留单一 SQLite 写入者及不同计量层的区分。

需要独立的 Node.js 24、PowerShell 7，以及正式声明的 Sharp 和 ws 依赖。Windows 默认使用 PowerShell/.NET 生成应用专用证书，不修改系统证书库。可通过 `powershellPath` 指定命令位置；已有 OpenSSL 部署仍可显式设置 `opensslPath`，不会在执行错误后自动切换工具。

`npm run test:pure` 只运行不需要 Sharp 或 ws 的离线测试。安装依赖后，`npm test` 还会验证图片转换和本机回环 HTTP／WebSocket；这些测试不调用真实模型。

## 安装

按照[安装指南](../../docs/getting-started.zh-CN.md)准备 Core 和需要的 Kits。安装本身不自动启动 Codex、修改路由或安装 Hook。

将本包的 `toolkit.example.json` 复制为安装目录的 `toolkit.json`，使用底座的 `start`、`status`、`launch` 命令。实际 `launch` 前必须完整退出 Codex，工具不会代为关闭它。默认不需要 CDP，也不安装主题或其他插件。状态首先显示转发就绪、原生路由尚未验证；收到模型请求后才改为已观察到转发，图片引用及计量结果见日志。

在配置中设置独立 PowerShell 7 的 `powershellPath`，并在插件 `options.powershellPath` 使用相同路径。运行 `codex-toolkit prepare ./toolkit.json` 生成双击入口，之后使用 `start-toolkit.cmd` 打开应用、`open-manager.cmd` 查看当前管理页。包没有额外的常驻启动项，不修改系统 PATH、证书库或 Codex 登录。

## 安装图片规则

以下命令只应在同意写入目标 Codex 配置时执行。两个目录必须使用绝对路径；`BANDWIDTH_STATE` 是配置的状态根目录下 `plugins/bandwidth`，不是整个 Codex 用户目录。

```powershell
./node_modules/.bin/codex-bandwidth.cmd install-rules 'CODEX_HOME' 'BANDWIDTH_STATE'
./node_modules/.bin/codex-bandwidth.cmd rules-status 'CODEX_HOME' 'BANDWIDTH_STATE'
```

安装器合并一条本机 `view_image` Hook，并安装 `codex-bandwidth-images` 技能，不覆盖其他 Hook、AGENTS.md 或信任状态。它记录自己的文件归属，修改 hooks.json 前保留备份；重复安装不叠加条目，已有手动修改或其他安装的同类 Hook 会明确报出冲突。不要将“已登记”理解为“已经运行”。Codex 要求对新增或变化的 Hook 做原生信任确认；可在原生 `/hooks` 界面检查并信任，首次生效时机以当前客户端加载结果为准。[官方 Hook 说明](https://learn.chatgpt.com/docs/hooks)

检查 Hook 只读取实际编码并记录元数据，不转图、不联网、不保存图片正文。技能提供图片生产与消费约定；具体工具覆盖范围见 [COVERAGE.md](./COVERAGE.md)。源码包和机器状态分开，安装路径变化后重新登记规则并重新确认 Hook。

撤除时使用同一组目录：

```powershell
./node_modules/.bin/codex-bandwidth.cmd remove-rules 'CODEX_HOME' 'BANDWIDTH_STATE'
```

该命令仅移除本安装登记的 Hook 和未被修改的技能文件，保留备份、日志、图片缓存、原生信任状态及无关配置。技能或 Hook 有手动修改时先报冲突，不强行删除。

## 查看流量与可选采集

管理页的“带宽与流量”显示时间范围、按线程模型计量、首次图片上传、缓存复用、请求分类和采集缺口，并可下载查询结果 JSON。它使用本插件的单一 SQLite 写入者，不将不同计量层相加。页面沿用现有流量界面的字号与配色，仅在可见且勾选跟随时每 10 秒刷新。

插件 options 中可选设置：

- `"cdpPort": "auto"`：为本次服务选择随机本机端口，通过本工具打开 Codex 时传入调试参数，并在观察到应用请求后连接 Chromium 采集。也接受显式端口。此项需要完整退出并从本工具重新启动应用；CDP 具有高权限且没有密码认证，只应在受信任的本机环境启用。未启用不影响图片引用或按线程模型计量。
- `"connections": true`：每 30 秒读取一次 Windows 进程连接快照，不要求管理员权限，不提供字节量。
- `"windowsDirectory": "ABSOLUTE_DIRECTORY"`：从指定目录增量导入独立 Windows ETW 采集器的结果。不自动提权或启动采集器。
- `"codexHome": "ABSOLUTE_CODEX_HOME"`：只读核对图片规则的安装状态；不修改该目录或替代原生信任确认。

Chromium 采集现在通过 Core 的公共 CDP 接口连接；与 Themes 等其他组件同时使用时，端口、浏览器连接和窗口目录只有一个拥有者。页面采集使用自身会话，暂停或停止只释放自己的 Tracing；不关闭其他插件的连接。未启用采集时仍不要求 CDP。连接中断会报告缺口，可通过工具集检查重新连接。

需要 Windows 全进程字节对照时，先配置 `windowsDirectory` 并正常重启本工具服务，再在 PowerShell 7 中显式运行采集器；`TOOLKIT_PID` 取底座 `status` 的服务 PID：

```powershell
& 'POWERSHELL7' -NoProfile -File './node_modules/codex-bandwidth/src/traffic-windows.ps1' -OutputDirectory 'WINDOWS_DIRECTORY' -ToolkitProcessId TOOLKIT_PID -PowerShellPath 'POWERSHELL7' -Elevate
```

此操作会请求 Windows 管理员确认。采集器只记录网络事件元数据，不解密正文；已有同类采集器时拒绝重复占用。停止时在该目录创建空文件 `stop`，采集器会释放自己的 ETW 会话。无管理员确认的 `-SelfTest` 只验证解码和所有权，不启动真实采集。实际权限、系统事件变化或事件丢失会显示为缺口或错误，不能当作完整流量。

## 原生图片规则检查

已启用的 Chromium 采集会随共享 CDP 连接恢复，成功后清除对应的当前连接错误；历史诊断仍保留。手动暂停的应用级字节采集在重连后仍保持暂停。断线期间的流量不会补算成零，也不重发模型请求。

首次收到模型请求，或收到新的原生版本标识时，插件会在后台核对当前桌面端实际使用的 Codex 程序。检查使用本机生成的合成图、独立临时状态和回环模型服务，不调用云端模型，不读取业务图片、登录文件或现有会话；每台机器保留自己的报告，不随包分发测试图片或 Codex 程序。

检查覆盖 `high`、`original` 和编译默认值的尺寸、编码及未缩放时的原始字节。相同程序文件身份和规则版本会复用已有结果；可用 `codex-toolkit check ./toolkit.json` 主动重新检查。检查结果保存在本插件状态目录的 `native-policy/native-policy-check.json`，详细的合成测试记录也留在该目录。

检查不会阻塞应用启动或模型转发。结果不匹配、原生程序发现失败、版本标识缺失等情况会反映在底座健康结果中，后续正常转发不会把错误清掉；主动检查成功可以更新对应的检查结果。版本标识缺失仍表示自动更新检查不可用，不能用一次手动通过掩盖。停止服务时只取消本工具创建的测试进程，不结束桌面端。每组隔离测试沿用 60 秒执行预算，该预算不用于判断桌面应用是否启动成功。

在本仓库运行源码测试时，先使用 `npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund --registry https://registry.npmjs.org` 安装锁定的第三方依赖，再用 `npm install --no-save --package-lock=false --strict-peer-deps --ignore-scripts CORE_TGZ` 安装匹配的 Core 本地归档，然后执行 `npm test`。源码工作目录的准备不能代替上面的正式跨包安装与兼容检查。

仓库中的 `test/package-smoke.mjs` 接受独立安装目录，第三个参数为 `native` 时使用默认 PowerShell 证书入口，也可传入现有 OpenSSL 路径。检查覆盖包导入、图片转换、独立证书、后台启停及生命周期，不发送真实模型请求或启动 Codex。

本包的代理可以读取经它转发的原生认证信息、文字与图片。默认日志只记录元数据，不保存请求正文或认证头。文件引用依赖 Codex 的非公开接线，未来客户端变化可能使其失效；当前候选版本还不能替代现有生产部署。

七天是本工具的缓存刷新策略，不是服务端有效期承诺。未到期引用继续复用；到期图片刷新失败时会明确报错，不回用旧引用、不批量上传其他图片，也不自动重发模型请求。服务端若提前撤销引用，仍可能出现文件引用错误。

## 升级与停用

完整退出使用该代理的 Codex，调用底座 `stop` 并确认服务停止后，才在原安装目录安装兼容版本的底座和本插件；保留配置、锁文件和状态，不在运行时覆盖文件。包安装和导入本身不改变 Codex 路由或 Hook。停用时先撤除已安装规则，再退出应用并停止服务，从原生入口启动 Codex；本工具的环境只传给其启动的子进程。数据和测试部署不会自动删除。

逻辑字节缩短不等于运营商账单节省，不同流量层不能相加。
