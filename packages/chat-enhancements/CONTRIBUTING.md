# Development

Install the matching local Core archive alongside this package, with install scripts disabled and strict peer checks enabled. No additional runtime dependency is required.

Run `npm test` for the algorithm, history, native-adapter and lifecycle checks. Run `node test/browser-smoke.mjs <absolute-edge-path>` with an already installed Edge to exercise DOM/CSS in a separate headless profile. The fixture controls animation-frame scheduling because Chromium's dump-dom virtual clock does not repaint every frame; it does not replace DOM or layout. Reports and profiles are retained under ignored `Temp` directories.

Native checks require a dedicated Codex installation started through Core. Verify current target identities before attaching; do not inject a second owner into a production renderer using the legacy controller. Keep live native evidence separate from synthetic browser results. Do not include Codex bundles, user configuration, credentials, histories or generated reports in commits or packages.
