# CodexTopKits — Core

[English](README.md) | 简体中文

Kit API 与独立工件说明见 [Kits](docs/features.md)，独立定义示例见 [Footer](kits/footer/README.zh-CN.md)；已有模块聚合入口继续兼容。

失败组件会自动重试恢复操作，每次操作结束后间隔 5 秒。默认健康提示在连续失败的首分钟保持安静，之后显示错误并继续重试。成功的健康报告立即清除错误并停止该组件的重试；正常组件没有重试定时器。诊断保留原始错误详情。恢复不会重发模型请求或用户操作、重启 Codex 或激活已准备的 Kit 更新。

模块可提供幂等的 `recover()`；否则 Core 使用既有 `check()`。每次操作通过 `context.setHealth()` 报告当前结果。Core 为每个组件串行重试，保留首次失败期限，并在宿主关闭时取消定时器。尝试期间报告的健康进展会在该次操作成功结束后才确认，后续初始化失败不会重置期限。待定健康结果含 `recovering: true` 和 `issueCount: 0`；组件管理接口仍保留详细诊断。

自 Core 0.3.43 起，重连无法修复的错误应通过 `context.setHealth()` 报告 `recoverable: false`。这些错误立即显示，不由 Core 自动重试，正常报告会清除错误，主动检查仍可用。页面 Kit 错误使用此模式；其他组件保留既有恢复行为。Kit 错误和恢复以 `kit-health-changed` 写入 `stateDirectory/events.jsonl`，包含目标、执行上下文和原始错误详情。

CodexTopKits 的公共运行底座。独立 Kit 通过本包的公开接口接入；[Traffic](../traffic/README.zh-CN.md) 提供图片节流与流量计量，[Themes](../themes/README.zh-CN.md) 用于维护外观功能。本包的导入名仍为 `codex-toolkit-core`。

本包使用 [Apache License 2.0](LICENSE)。

本包提供插件生命周期、按需共用 CDP、独立状态目录、UTF-8 日志、健康结果及 Windows 运行入口，不包含主题、语音、图片处理或其他插件。导入本包不会启动程序、连接 Codex 或开放调试端口。

需要 Node.js 24。运行 `npm test` 可执行本包的离线测试。

CDP 命令超时会以 `cdp-command-timeout` 写入 `stateDirectory/events.jsonl`，记录组件、目标、操作名、等待预算和实际耗时，不保存执行表达式或聊天正文。该诊断不改变超时预算，也不重发命令。

```js
import { createPluginHost } from 'codex-toolkit-core';

const host = await createPluginHost({
  stateDirectory: '/absolute/dedicated/toolkit-state',
  plugins: [],
});
console.log(host.health());
await host.close();
```

插件声明 `id`、`coreApiVersion: 1` 和 `start(context)`；启动后必须返回 `close()`，也可提供异步 `check()` 执行诊断。宿主提供该插件的 `stateDirectory`、`log(entry)` 和 `setHealth({ ok, message })`。只有传入宿主的插件才会运行，宿主不下载其他插件。插件代码具有当前用户的权限，宿主不提供安全沙箱。

## 共用 CDP

需要 CDP 的插件额外声明 `cdpPort: 'auto'` 或显式端口。Core 合并各插件的需求，统一选择端口和传递应用启动参数；显式端口冲突会在启动插件前报错。没有组件请求 CDP 时，不创建连接或调试启动参数。

插件通过 `await context.cdp.acquire({ signal })` 获取自己的访问对象。Core 只维护一个浏览器 WebSocket 和 target 目录，消费者可用 `targets()` 读取目录、在 `handlers` 集合订阅事件，并用 `send(method, params, sessionId?, timeoutMs?)` 发送命令。不同插件附加的会话分开归属，停止时 `await client.close()` 只释放本插件会话，不关闭其他消费者。插件的停止信号可取消自身启动等待，不会取消其他插件的连接。

Core 0.3.5 起，已建立的连接因应用退出或更新而断开时，Core 会注销旧 target 并在同一端口等待应用重新连接。插件用 `context.cdp.onReconnect(callback)` 订阅恢复，回调中重新 `acquire` 并附加自己的会话；订阅返回取消函数，插件关闭时应调用它。旧访问对象保持关闭，不能借此使用新连接。重连沿用 60 秒启动等待，只等待已知的连接拒绝／重置；解析、身份或其他未知错误直接报告，不自动重试。

浏览器 Tracing 同一时刻只有一个拥有者；消费者不能启动第二条 trace，也不能结束其他消费者的 trace。拥有者须等待自己的 `Tracing.tracingComplete`，再释放 CDP。窗口销毁或会话分离会取消其未完成命令，错误码为 `CDP_TARGET_CLOSED`；其他协议错误保留原 code、data 和诊断。浏览器连接中断须在插件检查入口重新接入，不掩盖为正常空目录。

CDP 延迟到首次使用才连接，服务可以先于应用启动。首次连接沿用 60 秒冷启动等待预算，只对本机尚未开放的监听器重试；解析、HTTP、身份及未知错误立即报告。常规命令保留原有 8 秒预算。端口无密码认证且具有高权限，只应在受信任本机环境中启用。

需要 renderer 内原生模块读取时，可从 `codex-toolkit-core/renderer` 使用 `createNativeAssetReader` 与 `loadNativeAppServices`。它们沿实际入口定位已加载的模块，不使用固定构建哈希；模块缺失或歧义保留具体错误。只有实际需要的插件才注入这些函数。

`loadNativeConversationRpc(document, { assets })` 返回现有会话 RPC 的 `forHost(hostId)`。发现过程不加载、恢复会话或重放历史，也不要求未读徽标接口存在；调用方只检查自己实际使用的方法。

`readNativeConversationIdentity(document)` 返回可见主聊天的 `taskKey`、`threadId` 与 `hostId`，供各插件共用；侧栏隐藏时仍从当前聊天读取，不把云端或远程会话当成本地会话。Dot 工作区没有可确认的聊天身份时返回 `null`。

`readNativeNotification(data)` 读取当前扁平格式或旧嵌套格式的 `mcp-notification`，保留原始参数，不复制、重放或修改事件；格式不符时报告具体错误。

`createNativeBridgeClient(window)` 为一个组件管理原生消息请求。`request(message, responseType, requestId, timeoutMs?)` 对应预加载层的请求／响应，`appServer(method, params, options?)` 返回原生 app-server 结果；错误保留远端 code、data 与 cause。没有待处理请求时不监听消息，`close()` 只取消本客户端的请求并释放监听。实例按组件归属创建，不接管其他组件的请求。

`acquireFooter(document, owner, hostState)` 让独立插件共用一个底栏和原生内容高度预留。返回 `left`、`center`、`right` 三个容器、`setHostState` 和 `release`；插件自行移除自己的节点，再释放租用。最后一个插件释放时才移除底栏、设置入口和布局样式。设置入口使用同一个 Core 管理地址及错误计数，不依赖某个具体插件安装。

插件可用 `context.onHostState(listener)` 接收共享管理地址与宿主健康状态，返回的函数用于取消订阅。地址在本机管理服务就绪后提供，健康未变化时不重复通知，宿主关闭时释放订阅。监听器应只更新本地状态，不等待应用或网络启动。`setHealth` 可用 `issueCount` 提供具体接口问题数；未提供时失败组件计为 1，正常组件为 0。

重连不能修复的错误可通过 `setHealth` 的 `recoverable: false` 明确报告：错误立即显示，Core 不自动重试，健康报告会清除该错误，仍可主动执行检查。页面 Kit 上报的错误采用此行为，其他组件保留既有恢复方式。Kit 错误与恢复变化以 `kit-health-changed` 写入现有 `stateDirectory/events.jsonl`，包含目标页面、执行上下文和原始错误详情。

## Windows 运行入口

需要独立的 Node.js 24 和 PowerShell 7。PowerShell 7 是必需运行环境，不支持 Windows PowerShell 5.1，也不会自动降级使用它；请使用 `pwsh.exe`，而不是 `powershell.exe`。在 PowerShell 7 终端中，从安装目录调用 `node_modules/.bin/codex-toolkit.cmd`；将配置示例复制为 `toolkit.json`。插件列表默认为空，只有显式列出的已安装插件才会加载。

```powershell
./node_modules/.bin/codex-toolkit.cmd start ./toolkit.json
./node_modules/.bin/codex-toolkit.cmd status ./toolkit.json
./node_modules/.bin/codex-toolkit.cmd check ./toolkit.json
./node_modules/.bin/codex-toolkit.cmd launch ./toolkit.json
./node_modules/.bin/codex-toolkit.cmd stop ./toolkit.json
```

`start` 后台运行，`serve` 在当前终端运行；`status` 查询当前实例。`launch` 使用插件的子进程设置和 Codex 注册的启动别名打开应用，执行前须完整退出 Codex。工具不会关闭或复用正在工作的实例，不修改用户环境变量或登录状态。

安装器独立确认所有 Codex 应用进程均已退出后，可调用 `stop CONFIG.json --application-exited`，在插件清理前释放陈旧 CDP 连接。仅在确认应用退出后使用此选项：它会结束共用连接，运行中的浏览器追踪可能仍需刷新数据。普通 `stop` 保留正常清理顺序；未完成的采集报告为缺口，未知清理错误保持可见。

共享 CDP 尚未连接时，`launch` 会在应用打开后恢复一次共享连接，让已安装功能重新附加；应用退出较久、原重连等待已经结束时，也不必再手动检查。该操作不触发整套插件诊断，具体功能错误仍保留在健康状态中。

`check` 让当前服务执行已安装插件的诊断，检查期间仍可查询状态。检查失败会保留具体错误，不关闭正在使用的应用或代理；插件未提供诊断时只保留其现有健康结果。

调试命令超时后，共享 CDP 会重建一次连接并通知插件重新接入，不重发原命令或模型请求。恢复仍失败时保留错误，不循环重试；新的实际断线或显式重接才重新允许这次恢复。页面插件共用 `codex-toolkit-core/cdp` 的 `initializePage(client, targetId, bindingName)`，初始化失败会释放该会话，成功后再登记供界面同步使用。

在 `toolkit.json` 中设置独立 PowerShell 7 的位置，例如 `"powershellPath": "C:/Program Files/PowerShell/7/pwsh.exe"`，然后运行：

```powershell
./node_modules/.bin/codex-toolkit.cmd prepare ./toolkit.json
```

该命令在配置旁生成 `start-toolkit.cmd` 和 `open-manager.cmd` 及其 PowerShell 脚本。以后双击前者启动服务并打开 Codex，双击后者打开本机管理页；不要直接双击 `.ps1`。已有未归本安装所有或被手动编辑的入口不会被覆盖。启动失败时窗口会保留具体错误，按 Enter 后关闭；正常启动完成后终端退出。

`powershellPath` 应使用不含版本号的稳定入口。Microsoft Store 安装可使用当前用户 `AppData/Local/Microsoft/WindowsApps/pwsh.exe` 的绝对路径；不要绑定 `WindowsApps/Microsoft.PowerShell_<版本号>/pwsh.exe`，该目录会随升级移除。插件如单独配置了 PowerShell 路径，也应使用同一稳定入口。更改路径后重新运行 `prepare`。

管理页只监听本机回环地址，`status` 返回本次实例的 `managerUrl`。页面列出已安装插件的健康状态和管理入口；页面地址带本地访问标识，不应公开分享。更换运行实例后地址可能变化，使用 `open-manager.cmd` 获取当前地址。管理页不开放跨站访问，操作接口还要求管理请求标识。

插件可提供 `management: { title, request({ method, url, body }) }`，返回 `{ body, type?, status?, headers? }` 或 `null`；宿主把 `/plugins/<id>/` 下的相对路径交给该插件，统一提供本机 HTTP 服务和访问校验。插件不必再启动另一套管理服务。未安装的插件不产生管理路由。

需要推送状态的管理页可返回 `{ subscribe(listener) }`，发送 JSON 状态并返回取消订阅函数。Core 通过同一受保护的回环服务提供 SSE，连接或管理服务关闭时释放订阅；不要求插件另开端口或用定时刷新重建控件。

同一状态目录只能有一个运行服务。Windows 命名管道持有所有权，进程退出后自动释放；旧 PID 文件不会导致工具结束其他进程。控制命令使用每次运行生成的本地令牌。状态目录中的 `runtime-stderr.log` 保存后台错误，`events.jsonl` 保存插件事件；每次应用启动助手的错误保存在 `launch-*/stderr.log`。

`stop` 只关闭本工具的插件和服务，不关闭 Codex；如果 Codex 仍通过节流代理发送请求，停止服务会中断连接，应先退出应用。更改配置前先停止旧服务。

## 升级与撤除

先完整退出通过本工具运行的 Codex，再调用 `stop` 并确认服务已停止，然后在安装目录用匹配版本的 Core 和所需组件归档执行严格 peer 安装。保留原 `toolkit.json`、状态和锁文件，不复制其他机器的证书或图片引用。升级不会自动执行；工具不替代 Codex 官方更新。

不再使用时，先退出应用并停止服务，再从原生入口打开 Codex；子进程专属环境不影响原生入口。日志与配置默认保留。若已安装某个插件的规则或 Hook，先使用该插件的撤除命令；本包不删除其他插件或用户配置。

需要删除程序文件时，在完成上述撤除后移除独立安装目录即可；状态目录若放在安装目录内，先备份需要保留的配置、日志与缓存。不要删除整个 Codex 用户目录或其他工程。

测试使用独立临时目录，不读取现有 Codex 配置、凭据或会话。支持范围目前为已验证的 Windows x64；未声明其他平台已验收。
