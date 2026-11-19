---
name: codex-bandwidth-images
description: Plan efficient screenshots and image delivery to Codex, verify actual image encoding, or prepare an observation copy. Use when a task reads or produces images for model inspection; preserve lossless sources and local measurement paths.
---

# Codex image delivery

For the current image path, establish its purpose and consumer before choosing encoding. Do not scan or rewrite unrelated tools, original images or project configuration.

- Qualitative observation: keep original dimensions, use lossy WebP85. Quantitative pixel, color or transparency work: use PNG and read the lossless original.
- Only model-bound images use Codex resize budgets. Local OCR, measurement and product exports keep their required dimensions and precision.
- A WebP resized by the verified native pipeline may become lossless. Ask the installed selector for the current dimensions rather than guessing from aspect ratio:

  ```powershell
  & {{NODE}} '{{ROOT}}/src/codex-image-policy.mjs' WIDTH HEIGHT model high
  ```

  Use an explicit `high` or `original` profile only after establishing the effective budget; `original` also requires the unified budget and model support. Without that evidence, compare both profiles; use their common encoding if they agree, otherwise establish the active profile first. An efficient resized WebP case uses JPG90 directly, without local resizing. Do not fall back for ordinary file or encoder errors.

- For an existing PNG used only for qualitative model observation, generate one UUID observation copy in the current project's `Temp`:

  ```powershell
  & {{NODE}} '{{ROOT}}/src/prepare-model-image.mjs' --sharp-entry {{SHARP}} --project 'ABSOLUTE_PROJECT' 'ABSOLUTE_SOURCE.png'
  ```

  Without `--profile`, the tool proceeds only when both budgets choose the same encoding; pass an established `--profile high` or `--profile original` otherwise. Preserve the source; pass the returned path to the image tool. The copy retains source path and times in metadata, so consider those before sharing it. For exact readings, use the source PNG instead.
- Inspect actual bytes when validating an image path:

  ```powershell
  & {{NODE}} '{{ROOT}}/src/image-delivery-audit.mjs' inspect 'ABSOLUTE_IMAGE'
  ```

PNG declares lossless intent; WebP/JPG permit loss. Keep suffix and actual encoding consistent. Do not turn a lossy image into PNG and claim it is a lossless source.

The installed `view_image` Hook checks local encoding metadata only. It does not convert images or intercept every screenshot tool, remote tool, inline tool-result image, or Computer Use output. For the task's authorized producer, use its real format controls or minimally adapt that current path; do not invent parameters. The proxy reuses image content by account and bytes, not file path, so overwriting a screenshot path does not intentionally reuse an old image.
