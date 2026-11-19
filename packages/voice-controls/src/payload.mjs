import { createNativeAssetReader } from 'codex-toolkit-core/renderer';
import { createVoiceDucking, loadNativeVoiceMedia, installVoiceVolume } from './voice-volume.mjs';
import { installVoiceRenderer } from './renderer.mjs';

export function voicePayload(state) {
  const helpers = { createNativeAssetReader, createVoiceDucking, loadNativeVoiceMedia, installVoiceVolume };
  return '(()=>{\n' + Object.entries(helpers).map(([name, fn]) => 'const ' + name + '= (' + fn.toString() + ');').join('\n')
    + '\nreturn (' + installVoiceRenderer.toString() + ')(window,' + JSON.stringify(state) + ',{' + Object.keys(helpers).join(',') + '});\n})()\n//# sourceURL=codex-desktop-toolkit-voice.js';
}
