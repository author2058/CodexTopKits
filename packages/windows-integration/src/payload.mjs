import { acquireFooter, createNativeBridgeClient, createNativeAssetReader, loadNativeAppServices, loadNativeConversationRpc, readNativeConversationIdentity, readNativeNotification } from 'codex-toolkit-core/renderer';
import { middleEllipsis } from './window-registry.mjs';
import { readSleepActivity } from './auto-sleep.mjs';
import { installWindowsRenderer } from './renderer.mjs';
import { installReadAloudMenu } from './read-aloud-menu.mjs';
import { installHostedUpdateControl, updateIndicatorCss } from './update-indicator.mjs';
import { loadNativeCloudUnread, installCloudUnreadControl } from './cloud-unread.mjs';
import { windowTabsCss, autoSleepCss, cloudReadCss } from './footer-styles.mjs';

export function windowsPayload(state) {
  const helpers = { acquireFooter, createNativeBridgeClient, createNativeAssetReader, loadNativeAppServices, loadNativeConversationRpc, readNativeConversationIdentity, readNativeNotification, middleEllipsis, readSleepActivity, installReadAloudMenu, installHostedUpdateControl, updateIndicatorCss, loadNativeCloudUnread, installCloudUnreadControl, windowTabsCss, autoSleepCss, cloudReadCss };
  return '(()=>{const helpers={' + Object.entries(helpers).map(([name, fn]) => JSON.stringify(name) + ':(' + fn.toString() + ')').join(',') + '};return (' + installWindowsRenderer.toString() + ')(window,' + JSON.stringify(state) + ',helpers)})()\n//# sourceURL=codex-desktop-toolkit-windows.js';
}
