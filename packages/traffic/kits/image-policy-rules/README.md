# Image policy rules

English | [简体中文](README.zh-CN.md)

Installs the `codex-bandwidth-images` skill and an image-inspection Hook. The skill helps choose image encoding for qualitative observation or exact pixel work and prepare an observation copy of an existing PNG. Observation copies retain the source path and timestamps in metadata; review that metadata before sharing a copy.

## Use

Install `codex-bandwidth`, add `image-policy-rules` to its `externalKits`, and place Bandwidth before the Kit runtime. Configure the following entry in the Kit runtime's `services`, using absolute paths to the Codex home and standalone Node executable:

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

Enable `image-policy-rules` in **Kits** and choose **Restart Kit host**. Codex may ask for native approval of the new or changed Hook; approve it in Codex and reload its configuration when needed. The Hook inspects local image encoding metadata for `view_image`; the skill describes how to select formats and prepare copies. The native image-policy check reports its result in Toolkit health.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
