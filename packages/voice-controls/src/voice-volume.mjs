import { createNativeAssetReader } from 'codex-toolkit-core/renderer';

// Local playback only. No audio or transcript leaves this module.
export function createVoiceDucking(media, {
  onChange = () => {}, onError = () => {}, now = () => performance.now(),
  startTimer = null, stopTimer = clearInterval,
  sampleLevel = null, holdMs = 3000, duckRatio = 0.1, releaseMs = 400,
} = {}) {
  const audio = media.audioElement;
  if (!audio || typeof audio.volume !== 'number') throw new Error('Voice volume: native playback element changed.');
  const normalVolume = audio.volume;
  let automatic = true, stopped = false, error = null, lastSpeech = -Infinity;
  let processor = null, source = null, stream = null, lastLevel = 0, timer = null;
  let rampAt = null, rampFrom = audio.volume, signature = null, loudSince = null;
  const snapshot = () => ({ automatic, volume: audio.volume, ducked: automatic && now() - lastSpeech < holdMs, error });
  const publish = () => {
    const value = snapshot();
    const next = JSON.stringify({ ...value, volume: Math.round(value.volume * 100) / 100 });
    if (next !== signature) { signature = next; onChange(value); }
  };
  const disconnect = () => {
    if (source && processor) source.disconnect(processor);
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); }
    source = null; stream = null; processor = null;
  };
  const level = sampleLevel || (() => {
    const mic = media.microphone;
    if (!mic?.context || typeof mic.getInputStream !== 'function') throw new Error('Voice volume: native microphone audio graph changed.');
    const currentStream = mic.getInputStream();
    if (!currentStream) throw new Error('Voice volume: native microphone stream is unavailable.');
    if (stream !== currentStream) {
      disconnect();
      stream = currentStream;
      source = mic.context.createMediaStreamSource(stream);
      // Audio callbacks stay responsive in the hidden voice host; ordinary
      // timers were measured near 1000ms there. This local metering branch
      // explicitly emits zeros and never copies microphone audio to speakers.
      processor = mic.context.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = event => {
        try {
          const input = event.inputBuffer.getChannelData(0);
          event.outputBuffer.getChannelData(0).fill(0);
          let sum = 0;
          for (const value of input) sum += value * value;
          lastLevel = Math.sqrt(sum / input.length);
        } catch (failure) { fail(failure); return; }
        sample();
      };
      source.connect(processor);
      processor.connect(mic.context.destination);
    }
    return mic.isMuted ? 0 : lastLevel;
  });
  const tick = () => {
    if (stopped) return;
    const time = now(), rms = level();
    if (!Number.isFinite(rms) || rms < 0) throw new Error('Voice volume: microphone level is invalid.');
    // Require 200ms of sustained activity: brief loud environmental sounds
    // neither trigger ducking nor extend an existing three-second hold.
    if (rms >= 0.012) {
      if (loudSince === null) loudSince = time;
      if (time - loudSince >= 200) { lastSpeech = time; rampAt = null; }
    } else loudSince = null;
    if (automatic) {
      if (time - lastSpeech < holdMs) {
        if (audio.volume !== normalVolume * duckRatio) audio.volume = normalVolume * duckRatio;
      }
      else if (audio.volume !== normalVolume) {
        if (rampAt === null) { rampAt = time; rampFrom = audio.volume; }
        const t = Math.min(1, (time - rampAt) / releaseMs);
        audio.volume = rampFrom + (normalVolume - rampFrom) * (1 - (1 - t) ** 3);
      }
    }
    publish();
  };
  const fail = (failure) => {
    error = { name: failure.name, message: failure.message, stack: failure.stack };
    automatic = false;
    stopTimer(timer); timer = null;
    audio.volume = normalVolume;
    try { disconnect(); } catch (cleanupError) { error.cleanup = { name: cleanupError.name, message: cleanupError.message, stack: cleanupError.stack }; }
    publish(); onError(failure);
  };
  const sample = () => { try { tick(); } catch (failure) { fail(failure); } };
  const control = {
    snapshot,
    tick,
    setManualVolume(volume) {
      if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new RangeError('Voice volume must be between 0 and 1.');
      automatic = false; rampAt = null; audio.volume = volume; publish();
    },
    setAutomatic(enabled) {
      if (typeof enabled !== 'boolean') throw new TypeError('Voice automatic mode must be boolean.');
      if (enabled && error) throw new Error(error.message);
      automatic = enabled; rampAt = null;
      if (enabled) sample(); else publish();
    },
    cleanup() {
      if (stopped) return;
      stopped = true; stopTimer(timer); timer = null;
      audio.removeEventListener('volumechange', publish);
      disconnect(); audio.volume = normalVolume;
    },
  };
  audio.addEventListener('volumechange', publish);
  try { tick(); if (startTimer) timer = startTimer(sample); }
  catch (failure) { control.cleanup(); throw failure; }
  return control;
}

export async function loadNativeVoiceMedia(document, {
  fetchModule = globalThis.fetch, importModule = (url) => import(url),
  assets = createNativeAssetReader(document, { fetchModule, importModule }),
} = {}) {
  const owner = await assets.find('WebRTC playback', source => source.includes('static async start(')
    && source.includes('getStream(){') && source.includes('setOutputAudioMuted('));
  let module;
  if (owner) module = owner.load();
  else {
    const initialUrl = await assets.resolve('app-initial');
    if (!initialUrl) throw new Error('Voice volume: app-initial module reference changed.');
    const source = await assets.read(initialUrl);
    const name = source.match(/webrtc-session-[A-Za-z0-9_-]+\.js/)?.[0];
    module = await importModule(name ? new URL(name, initialUrl).href : initialUrl);
  }
  const findMedia = () => [...new Set(Object.values(module))].filter(Media => typeof Media?.start === 'function'
    && typeof Media.prototype?.getStream === 'function' && typeof Media.prototype?.setOutputAudioMuted === 'function');
  let candidates = findMedia();
  if (!candidates.length) {
    // New bundles export the class before its native lazy initializer runs.
    // Initialize its owner, not a call or microphone, then reread live exports.
    const initializers = [...new Set(Object.values(module))].filter(value => {
      if (typeof value !== 'function' || typeof value.start === 'function') return false;
      const body = Function.prototype.toString.call(value);
      return body.includes('static async start(') && body.includes('getStream(){') && body.includes('setOutputAudioMuted(');
    });
    if (initializers.length === 1) { initializers[0](); candidates = findMedia(); }
  }
  if (candidates.length !== 1) {
    throw new Error('Voice volume: native WebRTC playback contract changed.');
  }
  return candidates[0];
}

export function installVoiceVolume(document, loadMedia, createDucking, onError = () => {}, onStatus = () => {}, translate = (key, values) => ({
  error: '语音音量控制异常：' + values?.message, hint: '自动：声音持续200毫秒后压低，停顿后保持3秒；拖动即转手动',
  slider: '语音播放音量', automatic: '自动躲避语音音量', auto: '自动',
})[key]) {
  const win = document.defaultView;
  const key = '__CODEX_VOICE_VOLUME__';
  const previous = win[key];
  if (previous?.version === 4 && !previous.status().error) { previous.setOnError(onError); previous.render(); return previous; }
  previous?.cleanup();
  const channel = new win.BroadcastChannel('codex-dynamic-theme-voice-volume-v1');
  let reportError = onError, stopped = false, active = null, remote = null, loadError = null;
  let Media, originalStart, wrappedStart;
  const readStatus = () => ({ ready: Boolean(Media), active: Boolean(active), visibleControls: controls.size, state: state(), error: loadError });
  const controls = new Map();
  const diagnostic = error => ({ name: error.name, message: error.message, stack: error.stack });
  const showError = error => {
    loadError = diagnostic(error);
    render();
    reportError(error);
  };
  const state = () => active ? { sessionKey: active.key, ...active.control.snapshot() } : remote;
  const broadcast = () => {
    if (!active) return;
    const next = state();
    channel.postMessage({ type: 'state', state: next });
    render();
  };
  const command = change => {
    const current = state();
    if (!current) return;
    if (active) {
      if ('volume' in change) active.control.setManualVolume(change.volume);
      else active.control.setAutomatic(change.automatic);
    } else channel.postMessage({ type: 'control', sessionKey: current.sessionKey, change });
  };
  const updateText = node => {
    const error = loadError || state()?.error;
    const title = error ? translate('error', { message: error.message }) : translate('hint');
    if (node.title !== title) node.title = title;
    for (const [selector, key] of [['input[type=range]', 'slider'], ['input[type=checkbox]', 'automatic']]) {
      const input = node.querySelector(selector), label = translate(key);
      if (input.getAttribute('aria-label') !== label) input.setAttribute('aria-label', label);
    }
    const text = node.querySelector('label').lastChild, label = translate('auto');
    if (text.nodeValue !== label) text.nodeValue = label;
  };
  const update = node => {
    const current = state();
    const error = loadError || current?.error;
    node.hidden = !current && !error;
    node.dataset.mode = current?.automatic ? 'auto' : 'manual';
    updateText(node);
    const slider = node.querySelector('input[type=range]');
    const checkbox = node.querySelector('input[type=checkbox]');
    const volume = Math.round((current?.volume ?? 1) * 100);
    // Do not replace the control or steal the user's drag/focus.
    if (slider.value !== String(volume)) slider.value = String(volume);
    slider.disabled = !current;
    slider.setAttribute('aria-valuetext', volume + '%');
    node.querySelector('output').textContent = volume + '%';
    checkbox.checked = current?.automatic ?? true;
    checkbox.disabled = !current || Boolean(error);
    node.toggleAttribute('data-error', Boolean(error));
  };
  function render() {
    if (stopped) return;
    const orbs = [...document.querySelectorAll('[data-testid="realtime-voice-stage-orb"]')];
    for (const [orb, node] of controls) {
      if (!orb.isConnected) { node.remove(); controls.delete(orb); }
    }
    for (const orb of orbs) {
      let node = controls.get(orb);
      if (!node) {
        node = document.createElement('div');
        node.className = 'codex-voice-volume';
        const slider = document.createElement('input');
        slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.value = '100';
        const output = document.createElement('output');
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = true;
        label.append(checkbox, document.createTextNode(''));
        node.append(slider, output, label);
        for (const type of ['pointerdown', 'click', 'dblclick', 'keydown']) node.addEventListener(type, event => event.stopPropagation());
        slider.addEventListener('input', () => {
          // Optimistic UI prevents a subsequent state message from restoring
          // the automatic checkmark while the cross-window command is in flight.
          if (remote) remote = { ...remote, automatic: false, volume: Number(slider.value) / 100 };
          checkbox.checked = false;
          command({ volume: Number(slider.value) / 100 }); update(node);
        });
        checkbox.addEventListener('change', () => command({ automatic: checkbox.checked }));
        controls.set(orb, node); orb.append(node);
      }
      update(node);
    }
    onStatus(readStatus());
  }
  const style = document.createElement('style');
  style.id = 'codex-voice-volume-style';
  style.textContent = '.codex-voice-volume{position:absolute;top:calc(100% - 15px);left:50%;transform:translateX(-50%);z-index:10;display:flex;align-items:center;gap:6px;width:220px;height:22px;pointer-events:auto;color:var(--color-token-text-secondary,light-dark(#475569,#aab4c4));font:12px/1.2 "Segoe UI",sans-serif;white-space:nowrap}.codex-voice-volume[hidden]{display:none}.codex-voice-volume input[type=range]{appearance:none;-webkit-appearance:none;width:133px;min-width:0;height:18px;margin:0;padding:0;border:0;background:transparent;accent-color:light-dark(#2563b8,#60a5fa);cursor:pointer}.codex-voice-volume input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:#64748b}.codex-voice-volume input[type=range]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:12px;height:12px;margin-top:-4px;border:1px solid light-dark(#1d4e89,#a4cbff);border-radius:50%;background:light-dark(#2563b8,#60a5fa);box-shadow:none}.codex-voice-volume output{width:28px;text-align:right;font-variant-numeric:tabular-nums}.codex-voice-volume label{display:flex;align-items:center;gap:3px;cursor:pointer}.codex-voice-volume input[type=checkbox]{width:12px;height:12px;margin:0;accent-color:light-dark(#2563b8,#60a5fa)}.codex-voice-volume[data-error]{color:light-dark(#b91c1c,#f87171)}';
  (document.head || document.documentElement).append(style);
  const observer = new win.MutationObserver(records => {
    const selector = '[data-testid="realtime-voice-stage-orb"]';
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
      node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector))))) render();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  channel.onmessage = ({ data }) => {
    if (stopped || !data || typeof data !== 'object') return;
    if (data.type === 'request-state') broadcast();
    else if (data.type === 'state' && !active) { remote = data.state; render(); }
    else if (data.type === 'ended' && remote?.sessionKey === data.sessionKey) { remote = null; render(); }
    else if (data.type === 'control' && active?.key === data.sessionKey) {
      try { command(data.change); } catch (error) { showError(error); }
    }
  };
  const attach = media => {
    if (stopped) return;
    if (!media?.dataChannel || typeof media.dataChannel.addEventListener !== 'function') throw new Error('Voice volume: native call lifecycle changed.');
    if (active) throw new Error('Voice volume: overlapping playback sessions in one renderer.');
    const call = { key: win.crypto.randomUUID(), media, control: null, onClose: null };
    const publish = () => { if (active === call) broadcast(); };
    call.control = createDucking(media, { onChange: publish, onError: showError });
    active = call;
    call.onClose = () => {
      if (active !== call) return;
      call.control.cleanup(); active = null;
      media.dataChannel.removeEventListener('close', call.onClose);
      channel.postMessage({ type: 'ended', sessionKey: call.key });
      render();
    };
    media.dataChannel.addEventListener('close', call.onClose, { once: true });
    broadcast();
  };
  const api = {
    version: 4, render, attach, state,
    renderText() { for (const node of controls.values()) updateText(node); },
    setOnError(callback) { reportError = callback; },
    status: readStatus,
    cleanup() {
      stopped = true; observer.disconnect();
      if (active) {
        const call = active; active = null;
        call.media.dataChannel.removeEventListener('close', call.onClose);
        call.control.cleanup(); channel.postMessage({ type: 'ended', sessionKey: call.key });
      }
      if (Media && Media.start === wrappedStart) Media.start = originalStart;
      channel.close(); for (const node of controls.values()) node.remove(); controls.clear(); style.remove();
      if (win[key] === api) delete win[key];
    },
  };
  api.ready = loadMedia(document).then(NativeMedia => {
    if (stopped) return false;
    Media = NativeMedia; originalStart = Media.start;
    wrappedStart = async function (...args) {
      const result = await originalStart.apply(this, args);
      // Failure in the optional local control must not break a native call.
      try { attach(result.session); } catch (error) { showError(error); }
      return result;
    };
    Media.start = wrappedStart;
    render(); return true;
  }).catch(error => { showError(error); return false; });
  win[key] = api;
  channel.postMessage({ type: 'request-state' }); render();
  return api;
}
