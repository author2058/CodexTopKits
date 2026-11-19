# Image reference deduplication

English | [简体中文](README.zh-CN.md)

Reuses uploaded image references for matching image content within the same account credential scope. References are refreshed when an image is used after seven days; the cache remains local to the Bandwidth service.

Install `codex-bandwidth`, add `image-reference-dedup` to its `externalKits`, and place Bandwidth before the Kit runtime. Configure `services.image-reference.module` as `codex-bandwidth/image-reference-service` and set `services.image-reference.startBeforeCdp` to `true` so the service is ready before Codex sends requests. Enable `image-reference-dedup` in **Kits** and choose **Restart Kit host**. Bandwidth's transport handles the matching model requests and can access their authentication information, text and images; its default log records metadata.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
