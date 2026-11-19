import manifest from './kit.json' with { type: 'json' };
import { createNativeAssetReader } from 'codex-toolkit-core/renderer';
import { createVoiceDucking, loadNativeVoiceMedia, installVoiceVolume } from '../../src/voice-volume.mjs';
import { installVoiceRenderer } from '../../src/renderer.mjs';

export const createVoiceVolume = ({ document, reportError, restartPreflight, i18n }, helpers) => {
  const messages = {
    en: { error: 'Voice volume control error: {message}', hint: 'Auto: lowers volume after 200 ms of sound and holds for 3 seconds after it stops; drag to switch to manual', slider: 'Voice playback volume', automatic: 'Automatic voice volume ducking', auto: 'Auto', restart: 'End the voice call before restarting the Kit host.' },
    'zh-Hans': { error: '语音音量控制异常：{message}', hint: '自动：声音持续200毫秒后压低，停顿后保持3秒；拖动即转手动', slider: '语音播放音量', automatic: '自动躲避语音音量', auto: '自动', restart: '语音通话进行中，请结束通话后再重启 Kit 宿主。' },
  };
  if (restartPreflight !== true) throw new Error('Voice volume requires Core 0.3.18 or later.');
  if (!i18n) throw new Error('Voice volume requires Core localization.');
  const view = document.defaultView, key = '__CODEXTOPKITS_VOICE__', binding = '__CDTK_KIT_VOICE_REPORT__';
  if (view.__CODEX_DESKTOP_TOOLKIT_VOICE__ || view.__CODEX_VOICE_VOLUME__ || view[key] || view[binding]) throw new Error('Voice volume already has an owner.');
  view[binding] = raw => {
    const report = JSON.parse(raw), error = report.error;
    reportError(error ? Object.assign(new Error(error.message), error) : null, 'voice');
    if (typeof view.__CDTK_VOICE_BRIDGE__ === 'function') view.__CDTK_VOICE_BRIDGE__(raw);
  };
  const translate = (name, values) => i18n.t(messages, name, values);
  try { helpers.installVoiceRenderer(view, { epoch: view.crypto.randomUUID() }, helpers, { key, binding, translate }); }
  catch (error) { delete view[binding]; throw error; }
  const unsubscribe = i18n.onChange(() => view[key]?.renderText?.());
  return {
    beforeRestart() {
      const status = view[key]?.status?.();
      if (status?.active || status?.state?.sessionKey) throw new Error(translate('restart'));
    },
    close() {
      unsubscribe(); view[key]?.cleanup(); delete view[binding];
      if (typeof view.__CDTK_VOICE_BRIDGE__ === 'function') view.__CDTK_VOICE_BRIDGE__(JSON.stringify({ applicable: view === view.top && (view.location.pathname === '/index.html' || view.location.pathname === '/'), status: null, error: null, disabled: true }));
    },
  };
};

export default { manifest, create: createVoiceVolume, helpers: { createNativeAssetReader, createVoiceDucking, loadNativeVoiceMedia, installVoiceVolume, installVoiceRenderer } };
