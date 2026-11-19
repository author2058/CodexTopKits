export function installVoiceRenderer(window, initial, helpers, options = {}) {
  const key = options.key || '__CODEX_DESKTOP_TOOLKIT_VOICE__', binding = options.binding || '__CDTK_VOICE_BRIDGE__', document = window.document;
  if (window !== window.top) return { applicable: false };
  if (window.__CODEX_DYNAMIC_THEME__) throw new Error('旧控制器仍在此页面运行；请先停止旧注入，再启用语音控制。');
  if (window[key]?.epoch === initial.epoch) return window[key].refresh();
  window[key]?.cleanup();
  if (document.readyState === 'loading') {
    const start = () => {
      delete window[key];
      try { installVoiceRenderer(window, initial, helpers, options); }
      catch (error) { window[binding](JSON.stringify({ applicable: false, error: { name: error.name, message: error.message, stack: error.stack } })); }
    };
    window[key] = { epoch: initial.epoch, refresh: () => ({ pending: true }), cleanup() { document.removeEventListener('DOMContentLoaded', start); delete window[key]; } };
    document.addEventListener('DOMContentLoaded', start, { once: true }); return { pending: true };
  }
  let control, stopped = false, signature = null, error = null;
  const applicable = window.location.pathname === '/index.html' || window.location.pathname === '/';
  const report = status => {
    if (stopped) return;
    const value = { applicable, status: status || control?.status() || null, error };
    const next = JSON.stringify(value);
    if (next !== signature) { signature = next; window[binding](next); }
    return value;
  };
  const failed = failure => { error = { name: failure.name, message: failure.message, stack: failure.stack }; report(); };
  const avatar = new URLSearchParams(window.location.search).get('initialRoute') === '/avatar-overlay';
  const ensure = () => {
    if (stopped || control || !applicable) return;
    // The native page imports playback before rendering its chat or avatar controls.
    if (!document.querySelector(avatar ? '#root button' : 'main.main-surface,main[class*="MainContentSurface"]')) return;
    observer.disconnect();
    control = helpers.installVoiceVolume(document, helpers.loadNativeVoiceMedia, helpers.createVoiceDucking, failed, report, options.translate);
    void control.ready.then(() => report()).catch(failed);
  };
  const observer = new window.MutationObserver(() => { try { ensure(); } catch (failure) { observer.disconnect(); failed(failure); } });
  const api = { epoch: initial.epoch,
    status() { return control?.status() || null; },
    renderText() { control?.renderText(); },
    refresh() { ensure(); control?.render(); return control?.ready.then(() => report()) || report(); },
    cleanup() { stopped = true; observer.disconnect(); control?.cleanup(); if (window[key] === api) delete window[key]; },
  };
  window[key] = api;
  if (applicable) {
    observer.observe(document.documentElement, { subtree: true, childList: true });
    ensure();
  }
  return report();
}
