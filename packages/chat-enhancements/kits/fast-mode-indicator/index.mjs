import manifest from './kit.json' with { type: 'json' };
import { createNativeBridgeClient, readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import { createDecorationsKit } from '../../src/model-decoration-kit.mjs';
import { installModelDecorations, readComposerModelSelection, sameModelSelection } from '../../src/model-decorations.mjs';
import { modelDecorationsCss } from '../../src/styles.mjs';

export const createFastModeIndicator = (context, helpers) => helpers.createDecorationsKit(context, helpers, 'fast-mode-indicator');
export default { manifest, create: createFastModeIndicator, helpers: { createDecorationsKit, createNativeBridgeClient, readNativeConversationIdentity,
  readNativeNotification, installModelDecorations, readComposerModelSelection, sameModelSelection, modelDecorationsCss } };
