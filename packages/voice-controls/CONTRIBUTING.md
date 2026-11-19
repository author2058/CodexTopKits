# Development

Install a matching local Core archive with install scripts disabled and strict peer checks enabled. Run `npm test`, then `node test/browser-smoke.mjs <absolute-edge-path>` with an already installed Edge. Browser checks use an audio element with no source and synthetic meter values; they do not open a microphone, speakers or a native call. Reports and profiles remain under ignored `Temp` directories.

Native validation must separately check the installed app's media class and a user-initiated voice call. A module-discovery success is not evidence of working live microphone ducking. Preserve the native call result when optional local controls fail, and never log audio or transcripts. Do not commit app bundles, private settings or runtime reports.
