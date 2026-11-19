import manifest from './kit.json' with { type: 'json' };
import { createNativeAssetReader, loadNativeAppServices, createNativeBridgeClient, readNativeConversationIdentity } from 'codex-toolkit-core/renderer';
import { canonicalTaskKey, projectNameForThread, resolveTheme } from '../../src/model.mjs';
import { themeCss, fontOverrideCss, themeColorCss, profilePanelShadowCss, themeChannelColor } from '../../src/styles.mjs';
import { installThemeRenderer } from '../../src/renderer.mjs';

export const createProjectThreadColors = ({ document, getRuntimeState, onRuntimeState, reportError }, helpers) => {
  const { resolveTheme, themeColorCss, themeChannelColor, installThemeRenderer } = helpers;
  const view = document.defaultView, legacy = view.__CODEX_DESKTOP_TOOLKIT_THEMES__;
  const channels = ['accent', 'canvas', 'surface', 'sidebar'];
  const map = () => {
    const value = getRuntimeState()?.themeSettings?.map;
    if (!value || !value.enabledColors || !value.themes || !value.projects || !value.tasks) throw new Error('Theme settings are unavailable.');
    return value;
  };
  if (legacy) {
    if (!legacy.handoffs?.colors || typeof legacy.onContext !== 'function') throw new Error('The existing Themes module has not handed off project colors.');
    const style = document.createElement('style'); style.setAttribute('data-cdtk-owned', 'project-thread-colors'); style.textContent = themeColorCss();
    let current = null;
    const paint = () => {
      const settings = map(), resolved = resolveTheme(settings, current || {}), active = Boolean(current?.applicable);
      if (active && !style.isConnected) document.head.appendChild(style); else if (!active) style.remove();
      for (const channel of channels) {
        const enabled = Boolean(active && resolved.theme && settings.enabledColors[channel]);
        const className = 'cdtk-theme-' + channel, variable = '--cdtk-' + channel, value = enabled ? themeChannelColor(channel, resolved.theme[channel], resolved.theme.accent) : '';
        if (document.documentElement.classList.contains(className) !== enabled) document.documentElement.classList.toggle(className, enabled);
        if (document.documentElement.style.getPropertyValue(variable) !== value) value ? document.documentElement.style.setProperty(variable, value) : document.documentElement.style.removeProperty(variable);
      }
    };
    const unsubscribeContext = legacy.onContext(value => {
      current = value;
      try { paint(); reportError(value ? null : new Error('The shared Themes context stopped.'), 'context'); }
      catch (error) { reportError(error, 'context'); }
    });
    const unsubscribeState = onRuntimeState(paint);
    try { paint(); } catch (error) { unsubscribeContext(); unsubscribeState(); style.remove(); throw error; }
    return { close() {
      unsubscribeContext(); unsubscribeState(); style.remove();
      for (const channel of channels) { document.documentElement.classList.remove('cdtk-theme-' + channel); document.documentElement.style.removeProperty('--cdtk-' + channel); }
    } };
  }
  const key = '__CODEXTOPKITS_PROJECT_COLORS__', binding = '__CDTK_KIT_COLORS_REPORT__', styleId = 'cdtk-kit-colors-style', errors = new Set();
  if (view[key] || view[binding]) throw new Error('Project colors already have an owner.');
  view[binding] = raw => {
    const report = JSON.parse(raw), next = new Set();
    for (const issue of report.errors) { const source = 'native:' + issue.source; next.add(source); reportError(Object.assign(new Error(issue.message), issue), source); }
    for (const source of errors) if (!next.has(source)) reportError(null, source);
    errors.clear(); for (const source of next) errors.add(source);
  };
  let renderer;
  try { renderer = installThemeRenderer(view, map(), helpers, { key, binding, styleId, profileShadow: false, externalKits: ['ui-font-size'] }); }
  catch (error) { delete view[binding]; throw error; }
  const unsubscribeState = onRuntimeState(() => view[key]?.update(map()));
  return { close() { unsubscribeState(); view[key]?.cleanup(); delete view[binding]; } };
};

export default { manifest, create: createProjectThreadColors, helpers: { canonicalTaskKey, projectNameForThread, resolveTheme, themeCss, fontOverrideCss,
  themeColorCss, profilePanelShadowCss, themeChannelColor, createNativeAssetReader, loadNativeAppServices, createNativeBridgeClient, readNativeConversationIdentity, installThemeRenderer } };
