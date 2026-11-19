import fs from 'node:fs/promises';
import path from 'node:path';
import { openThemeStore } from './store.mjs';

export const serviceApiVersion = '1.0.0';
export default async function createThemeSettingsService({ legacyPlugin, mapPath, enabled = [] } = {}, context) {
  let selected = new Set(enabled), signature, readMap;
  const settings = map => ({ uiFontSizeOverride: map.uiFontSizeOverride, ...(selected.has('project-thread-colors') ? { map } : {}) });
  const configure = selection => { selected = new Set(selection); signature = readMap ? JSON.stringify(settings(readMap())) : null; };
  const changed = map => {
    const next = JSON.stringify(settings(map)); if (signature === next) return;
    signature = next; void context.notify().catch(error => context.reportError(error, 'notify'));
  };
  if (legacyPlugin) {
    const owner = context.getPlugin?.(legacyPlugin);
    if (!owner?.featureState || !owner?.onFeatureState) throw new Error('Legacy Themes module does not support Kit handoff.');
    readMap = () => owner.featureState().themeSettings.map; signature = JSON.stringify(settings(readMap()));
    const unsubscribe = owner.onFeatureState(value => changed(value.themeSettings.map));
    return { snapshot: () => ({ themeSettings: settings(readMap()) }), configure, receive: () => false, removeTarget() {}, close() { unsubscribe(); } };
  }
  const initial = JSON.parse(await fs.readFile(new URL('../assets/theme-map.json', import.meta.url), 'utf8'));
  const store = await openThemeStore({ filename: mapPath ?? path.join(context.stateDirectory, 'theme-map.json'), defaultMap: initial,
    changed(map) {
      context.reportError(null, 'map');
      changed(map);
    }, failed: error => context.reportError(error, 'map') });
  readMap = () => store.map; signature = JSON.stringify(settings(readMap()));
  return { snapshot: () => ({ themeSettings: settings(readMap()) }), configure, receive: () => false, removeTarget() {}, close: () => store.close() };
}
