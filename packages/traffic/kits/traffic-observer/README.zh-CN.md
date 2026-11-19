# Traffic observer

[English](README.md) | 简体中文

采集模型流量元数据，并在 **带宽与流量** 中按时间范围、聊天和模型显示用量。页面包含图片上传与缓存复用、请求分类和采集缺口，并可将查询结果下载为 JSON。采集从启用观察器时开始。

安装 `codex-bandwidth`，将 `traffic-observer` 加入其 `externalKits`，并将 Bandwidth 放在 Kit 宿主之前。将 `services.traffic-observer.module` 配置为 `codex-bandwidth/traffic-observer-service`，并将 `services.traffic-observer.startBeforeCdp` 设为 `true`。在 **插件** 中启用 `traffic-observer`，点击 **重启插件宿主**，再打开 **带宽与流量**。

Bandwidth 可通过 `cdpPort` 选用 Chromium 流量采集，通过 `connections` 采集 Windows 连接快照，或通过 `windowsDirectory` 导入独立 Windows 采集器的数据。CDP 权限较高且没有密码认证，请仅在受信任的本机环境启用。Bandwidth 的传输服务可访问转发请求中的认证信息、文字和图片；默认日志记录元数据。不同层级的计量反映各自的范围。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
