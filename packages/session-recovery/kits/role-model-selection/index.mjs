import manifest from './kit.json' with { type:'json' };
import { createNativeBridgeClient, readNativeConversationIdentity } from 'codex-toolkit-core/renderer';
import { createRoleModelSelection } from '../../src/role-model-renderer.mjs';
import { findRoleModelAnchor, readRoleModelControl, applyRoleModelControl } from '../../src/role-model-native.mjs';
export default { manifest, create:createRoleModelSelection, helpers:{ findRoleModelAnchor, readRoleModelControl, applyRoleModelControl, readNativeConversationIdentity, createNativeBridgeClient },
  backendPath:new URL('../../src/role-model-backend.mjs',import.meta.url), assets:Object.fromEntries(manifest.assets.map(name=>[name,new URL('../../src/'+name,import.meta.url)])) };
