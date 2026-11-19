import { createNativeAssetReader, loadNativeAppServices, createNativeBridgeClient, readNativeConversationIdentity } from 'codex-toolkit-core/renderer';
import { canonicalTaskKey, projectNameForThread, resolveTheme } from './model.mjs';
import { themeCss, fontOverrideCss, themeColorCss, profilePanelShadowCss, themeChannelColor } from './styles.mjs';
import { installThemeRenderer } from './renderer.mjs';

export function themePayload(map, options = {}) {
  const helpers = { canonicalTaskKey, projectNameForThread, resolveTheme, themeCss, fontOverrideCss, themeColorCss, profilePanelShadowCss, themeChannelColor, createNativeAssetReader, loadNativeAppServices, createNativeBridgeClient, readNativeConversationIdentity };
  const effective = { ...options, profileShadow: options.profileShadow !== false && !options.externalKits?.includes('profile-panel-shadow') };
  return `(() => { const helpers = {${Object.entries(helpers).map(([name, fn]) => JSON.stringify(name) + ':(' + fn.toString() + ')').join(',')}}; const {fontOverrideCss,themeColorCss,profilePanelShadowCss}=helpers; return (${installThemeRenderer.toString()})(window,${JSON.stringify(map)},helpers,${JSON.stringify(effective)}); })()\n//# sourceURL=codex-desktop-toolkit-themes.js`;
}
