export function createCloudMarkRead({ document, dependencies, onDomChange, reportError, i18n }, helpers) {
  if (typeof i18n?.t !== 'function' || typeof i18n?.onChange !== 'function') throw new Error('cloud-mark-read requires Core 0.3.39 or later.');
  const messages = {
    en: { clear: 'Clear cloud unread', disconnected: 'Cloud unread is not connected yet. Check the settings page for details.' },
    'zh-Hans': { clear: '清理云端未读', disconnected: '云端未读接口尚未连接，请在设置页查看详情。' },
  };
  const { createNativeAssetReader, loadNativeConversationRpc, loadNativeCloudUnread, installCloudUnreadControl, cloudReadCss } = helpers;
  let lease, button, control, loading, stopped = false;
  const style = document.createElement('style'); style.setAttribute('data-cdtk-owned', 'cloud-mark-read'); style.textContent = cloudReadCss();
  const unmount = () => { button?.remove(); lease?.release(); lease = button = null; };
  const renderText = () => {
    if (!button) return;
    const label = i18n.t(messages, 'clear');
    for (const attribute of ['title', 'aria-label']) if (button.getAttribute(attribute) !== label) button.setAttribute(attribute, label);
  };
  const refresh = () => {
    if (stopped) return;
    if (!document.querySelector('main.main-surface,main[class*="MainContentSurface"]')) { unmount(); return; }
    if (!lease) {
      lease = dependencies.footer.acquire('cloud-mark-read'); button = document.createElement('button'); button.type = 'button'; button.className = 'cdtk-clear-cloud-unread';
      button.setAttribute('data-cdtk-owned', 'cloud-mark-read'); renderText();
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m3 10 9-7 9 7v10H3z"/><path d="m3 10 9 7 9-7M7 13V7h10v6"/></svg>';
      button.addEventListener('click', () => {
        if (!control) { reportError(new Error(i18n.t(messages, 'disconnected')), 'action'); return; }
        void control.clear().then(() => { reportError(null, 'action'); refresh(); }).catch(error => reportError(error, 'action'));
      });
      lease.right.appendChild(button);
    }
    const busy = control?.status().busy === true; if (button.disabled !== busy) button.disabled = busy;
    if (!loading) {
      loading = (async () => {
        const assets = createNativeAssetReader(document), nativeHost = await loadNativeConversationRpc(document, { assets });
        const native = await loadNativeCloudUnread(document, { assets, nativeHost });
        if (stopped) return;
        control = installCloudUnreadControl(native.readState, native.badgeStore, native.markRead, () => { if (!stopped) document.defaultView.queueMicrotask(refresh); });
        reportError(null, 'native'); refresh();
      })();
      loading.catch(error => { if (!stopped) reportError(error, 'native'); });
    }
  };
  let unsubscribe, unsubscribeLocale;
  try { unsubscribeLocale = i18n.onChange(renderText); unsubscribe = onDomChange(refresh); document.head.appendChild(style); refresh(); }
  catch (error) { stopped = true; unsubscribe?.(); unsubscribeLocale?.(); unmount(); style.remove(); throw error; }
  return { async close() { stopped = true; unsubscribe(); unsubscribeLocale(); await loading?.catch(() => { /* Already reported through the feature's native error. */ }); control?.cleanup(); unmount(); style.remove(); } };
}
