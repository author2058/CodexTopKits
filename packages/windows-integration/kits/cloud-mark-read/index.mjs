import manifest from './kit.json' with { type: 'json' };
import { createNativeAssetReader, loadNativeConversationRpc } from 'codex-toolkit-core/renderer';
import { loadNativeCloudUnread, installCloudUnreadControl } from '../../src/cloud-unread.mjs';
import { createCloudMarkRead } from '../../src/cloud-read-feature.mjs';
import { cloudReadCss } from '../../src/footer-styles.mjs';
export default { manifest, create: createCloudMarkRead, helpers: {
  createNativeAssetReader, loadNativeConversationRpc, loadNativeCloudUnread, installCloudUnreadControl, cloudReadCss,
} };
