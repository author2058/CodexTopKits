# Image policy rules

[English](README.md) | 简体中文

安装 `codex-bandwidth-images` skill 和图片检查 Hook。该 skill 帮助按定性观察或精确像素读取选择图片编码，并为已有 PNG 准备观察副本。观察副本的元数据包含来源路径和时间戳，分享前请检查这些元数据。

### 使用

安装 `codex-bandwidth`，将 `image-policy-rules` 加入其 `externalKits`，并将 Bandwidth 放在 Kit 宿主之前。在 Kit 宿主的 `services` 中添加以下配置，使用 Codex home 和独立 Node 可执行文件的绝对路径：

```json
{
  "image-policy": {
    "module": "codex-bandwidth/image-policy-service",
    "options": {
      "codexHome": "C:/path/to/codex-home",
      "nodeExecutable": "C:/path/to/node.exe"
    }
  }
}
```

在 **插件** 中启用 `image-policy-rules`，再点击 **重启插件宿主**。Codex 可能要求原生确认新增或更改的 Hook；在 Codex 中批准，并按需重新加载配置。Hook 检查 `view_image` 使用的本地图片编码元数据；skill 说明如何选择格式和准备副本。原生图片规则检查结果显示在工具集健康状态中。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
