import manifest from './kit.json' with { type: 'json' };
import { readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import { createScrollKit } from '../../src/scroll-kit.mjs';
import { installScrollDiagnostics } from '../../src/scroll-diagnostics.mjs';

export const createScrollDiagnostics = (context, helpers) => helpers.createScrollKit(context, helpers, 'scroll-diagnostics');
export default { manifest, create: createScrollDiagnostics, helpers: { createScrollKit, readNativeConversationIdentity, readNativeNotification,
  installScrollDiagnostics } };
