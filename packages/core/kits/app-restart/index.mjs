import manifest from './kit.json' with { type: 'json' };
import { createNativeAssetReader, loadNativeAppServices } from '../../src/renderer.mjs';
import { nativeQuitItem, installRestartMenu } from '../../src/application-menu.mjs';

export function createAppRestart({ document, dispatch, reportError, onDomChange, i18n }, helpers) {
  const messages = { en: { restart: 'Restart with CodexTopKits' }, 'zh-Hans': { restart: '使用 CodexTopKits 重启' } };
  let menu, loading = false, closed = false;
  const refresh = () => {
    if (closed || loading || menu || !document.getElementById('application-menu-trigger-file-menu')) return;
    loading = true;
    void (async () => {
      const services = await helpers.loadNativeAppServices(document, { assets: helpers.createNativeAssetReader(document) });
      helpers.nativeQuitItem(await services.applicationMenu.getSnapshot());
      if (!closed) { menu = helpers.installRestartMenu(services, { restart: () => dispatch({ kind: 'app-restart' }), onError: error => reportError(error, 'restart'), label: () => i18n.t(messages, 'restart') }, helpers.nativeQuitItem); reportError(null, 'menu'); }
    })().catch(error => { if (!closed) reportError(error, 'menu'); }).finally(() => unsubscribe());
  };
  const unsubscribe = onDomChange(refresh); refresh();
  return { close() { closed = true; unsubscribe(); menu?.close(); } };
}
export default { manifest, create: createAppRestart, helpers: { createNativeAssetReader, loadNativeAppServices, nativeQuitItem, installRestartMenu } };
