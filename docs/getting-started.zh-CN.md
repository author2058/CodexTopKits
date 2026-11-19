# 开始使用

[English](getting-started.md) | 简体中文

从源码仓库在 Windows x64 上安装 CodexTopKits，先启用底栏、设置按钮和表格样式。

## 1. 准备环境

安装 Codex 桌面应用、带 npm 的 Node.js 24 或更高版本，以及 PowerShell 7。克隆或解压本仓库后，在仓库根目录打开 PowerShell 7，安装依赖：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
```

## 2. 准备本地安装

在仓库根目录执行：

```powershell
$destination = [IO.Path]::GetFullPath('./state/local')
New-Item -ItemType Directory -Path ./state -Force | Out-Null
node tools/prepare-source-install.mjs --destination $destination --node (Get-Command node.exe).Source --powershell (Get-Command pwsh.exe).Source --kit footer --kit manager-entry --kit table-style
```

选择一个新建或空的安装目录。安装工具会构建所选 Kits 及其依赖，安装所需工作区模块，生成 `toolkit.json` 并准备启动入口。npm 使用第 1 步填充的依赖缓存。各 Kit 保持独立版本和更新选择。

首次安装更多功能时，可在执行前为每个 Kit 增加一个 `--kit ID` 参数，安装工具会配置共享服务及所需模块的能力交接。选择 `ui-font-size` 或 `project-thread-colors` 会包含 **主题设置** 页面；选择 `awake-bridge` 会包含其防睡眠脚本。

`image-policy-rules` 和 `context-recovery-integration` 还需要通过 `--codex-home` 提供 Codex 配置目录的绝对路径。例如：

```powershell
$codexDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
node tools/prepare-source-install.mjs --destination $destination --node (Get-Command node.exe).Source --powershell (Get-Command pwsh.exe).Source --codex-home $codexDirectory --kit footer --kit manager-entry --kit image-policy-rules --kit image-reference-dedup --kit traffic-observer --kit context-recovery-integration --kit awake-bridge --kit ui-font-size --kit project-thread-colors
```

为同一个空目录选择上述一套示例执行。npm 与 Node 分开安装时，可用 `--npm` 指定 `npm-cli.js` 的绝对路径。安装代码、设置、Kit 工件和运行状态均保存在目标目录，应保持该目录位置固定。`agent-model-protection` 按需启用，仅在需要其 v1 子聊天保护流程时加入对应 ID。

## 3. 打开管理器和 Codex

```powershell
./state/local/open-manager.cmd
```

管理器的 **插件** 页显示已选择的版本。正常退出 Codex，再打开：

```powershell
./state/local/start-toolkit.cmd
```

Codex 会带着所选 Kits 启动。底栏设置按钮打开当前管理器地址；`open-manager.cmd` 每次也会查找当前地址。启动入口会等待正在退出的 Codex 进程结束，再打开应用。

## 添加、停用或更新 Kit

1. 从[功能目录](../README.zh-CN.md#kits)选择 Kit，阅读前提条件，执行 `node packages/core/src/feature-pack.mjs packages/<module>/kits/<kit>/index.mjs Temp/kits` 构建其 `index.mjs`。先创建 `Temp/kits`；同版本工件已构建时，改用新的构建目录。
2. 在 **插件** 页的 **本地插件文件夹** 中填写工件绝对路径，点击 **准备本地安装**，并添加所需的依赖 Kits。
3. 为要启用的 Kits 勾选 **重启后运行**，再点击 **重启插件宿主**。所选功能重新加载时，Codex 和模型连接保持运行。
4. 更新已有 Kit 时，在其所在行填入新版工件文件夹，点击 **准备本地更新**，再重启插件宿主。

新的源码安装默认使用 `author2058/CodexTopKits` 作为 GitHub 更新仓库。公开仓库无需令牌。点击**检查更新**后，管理器会列出该仓库 `kits` release 中的独立 Kits；选择要准备的更新后，重启插件宿主。如需使用其他受信任目录，在源码安装命令中加入 `--update-repository owner/repository`。私有仓库的身份验证和工件细节参见[目录配置](../packages/core/docs/features.md#restartable-kit-host)。

### 使用共享服务的 Kits

源码安装工具会为所选 Kits 配置服务。后续添加 Kit 时，其 README 会列出必需的模块和服务设置。启动 Toolkit 前，在 `artifacts` 所在的 `options` 对象中配置服务。例如，输出编号使用 `chat-history`，计时器和滚动工具使用 `chat-diagnostics`：

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

将示例路径替换为实际绝对路径，并列出所有要加载的 Kits。服务的额外设置放在 `module` 旁的 `options` 对象中。服务配置变更通过完整重启 Toolkit 生效：先保存工作、退出 Codex，再停止 Toolkit 并使用启动入口重开。

```powershell
node state/local/node_modules/codex-toolkit-core/src/cli.mjs stop ./state/local/toolkit.json --application-exited
./state/local/start-toolkit.cmd
```

## 设置与安全

- Kit 代码使用当前用户的文件与网络权限，应选择可信来源，并审查所需的 Hook 安装。
- `cdpPort: "auto"` 选择随机本机回环调试端口，该通道具有访问 Codex 的较高权限，应将访问范围限制在可信的本机软件内。
- 设置、日志和采集的诊断信息保存在配置的 `stateDirectory` 下；寻求帮助时使用已脱敏的摘录。
- 管理器语言选项包含跟随宿主的自动模式、英语和简体中文。
- 修改后的 Hook 可能需要在 Codex 的 **Settings → Hooks** 中批准，并在新 Codex 会话中加载；可通过状态显示核对是否已启用。

[app-restart Kit](../packages/core/kits/app-restart/README.md#简体中文)提供带 20 秒确认倒计时的 **File → Restart with CodexTopKits**。开发其他 Kit 可参考 [Kit API 指南](../packages/core/docs/features.md)。
