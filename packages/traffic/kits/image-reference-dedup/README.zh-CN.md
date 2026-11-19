# Image reference deduplication

[English](README.md) | 简体中文

在相同账户凭据作用域内，为内容相同的图片复用已上传引用。图片在七天后再次使用时会刷新引用；缓存保存在本机 Bandwidth 服务中。

安装 `codex-bandwidth`，将 `image-reference-dedup` 加入其 `externalKits`，并将 Bandwidth 放在 Kit 宿主之前。将 `services.image-reference.module` 配置为 `codex-bandwidth/image-reference-service`，并将 `services.image-reference.startBeforeCdp` 设为 `true`，使服务在 Codex 发送请求前就绪。在 **插件** 中启用 `image-reference-dedup`，再点击 **重启插件宿主**。Bandwidth 的传输服务处理匹配的模型请求，可访问其中的认证信息、文字和图片；默认日志记录元数据。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
