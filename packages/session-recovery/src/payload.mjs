import { createNativeBridgeClient, createNativeAssetReader, readNativeNotification, readNativeConversationIdentity } from 'codex-toolkit-core/renderer';
import { normalizeRuntimeSettings, sameRuntimeSettings, createRuntimeGuard } from './runtime-settings.mjs';
import { installAgentComposerRestore } from './agent-composer.mjs';
import { installSessionRenderer } from './renderer.mjs';

export function sessionPayload(state) {
  const helpers={createNativeBridgeClient,createNativeAssetReader,readNativeNotification,readNativeConversationIdentity,normalizeRuntimeSettings,sameRuntimeSettings,createRuntimeGuard,installAgentComposerRestore};
  return '(()=>{const helpers={'+Object.entries(helpers).map(([name,fn])=>JSON.stringify(name)+':('+fn.toString()+')').join(',')+'};return ('+installSessionRenderer.toString()+')(window,'+JSON.stringify(state)+',helpers)})()\n//# sourceURL=codex-desktop-toolkit-session.js';
}
