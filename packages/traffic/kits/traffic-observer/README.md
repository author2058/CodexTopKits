# Traffic observer

English | [简体中文](README.zh-CN.md)

Collects model-traffic metadata and displays usage by time range, chat and model in **Bandwidth and traffic**. The page includes image uploads and cache reuse, request categories and collection gaps, and can download query results as JSON. Collection begins when the observer is enabled.

Install `codex-bandwidth`, add `traffic-observer` to its `externalKits`, and place Bandwidth before the Kit runtime. Configure `services.traffic-observer.module` as `codex-bandwidth/traffic-observer-service` and set `services.traffic-observer.startBeforeCdp` to `true`. Enable `traffic-observer` in **Kits**, choose **Restart Kit host**, and open **Bandwidth and traffic**.

Bandwidth can optionally collect Chromium traffic via `cdpPort`, Windows connection snapshots via `connections`, or import an independent Windows collector's data via `windowsDirectory`. CDP has high privileges and no password authentication; enable it only on a trusted local machine. Bandwidth's transport can access forwarded authentication information, text and images; its default log records metadata. Measurements from different layers describe different scopes.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
