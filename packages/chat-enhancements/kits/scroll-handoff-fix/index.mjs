import manifest from './kit.json' with { type: 'json' };
import { readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import { createScrollKit } from '../../src/scroll-kit.mjs';
import { installScrollHandoffRepair, scrollHandoffCorrection } from '../../src/scroll-handoff.mjs';

export const createScrollHandoffFix = (context, helpers) => helpers.createScrollKit(context, helpers, 'scroll-handoff-fix');
export default { manifest, create: createScrollHandoffFix, helpers: { createScrollKit, readNativeConversationIdentity, readNativeNotification,
  installScrollHandoffRepair, scrollHandoffCorrection } };
