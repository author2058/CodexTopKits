import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceDucking, loadNativeVoiceMedia, installVoiceVolume } from '../src/voice-volume.mjs';

class Audio extends EventTarget {
  volume = 1;
  muted = false;
}
function fixture(initialLevel = 0) {
  let time = 0, rms = initialLevel, timer, cleared = 0;
  const audio = new Audio(), changes = [], failures = [];
  const control = createVoiceDucking({ audioElement: audio }, {
    now: () => time, sampleLevel: () => rms,
    startTimer: callback => { timer = callback; return 1; }, stopTimer: () => cleared++,
    onChange: value => changes.push(value), onError: error => failures.push(error),
  });
  return { audio, control, changes, failures, get cleared() { return cleared; },
    at(value, level = rms) { time = value; rms = level; control.tick(); },
    sample(value) { rms = value; timer(); },
  };
}

test('sustained speech ducks after 200ms and retains the three-second hold', () => {
  const f = fixture();
  f.at(40, 0.03); assert.equal(f.audio.volume, 1);
  f.at(239); assert.equal(f.audio.volume, 1);
  f.at(240); assert.equal(f.audio.volume, 0.1);
  f.at(2500, 0); assert.equal(f.audio.volume, 0.1);
  f.at(2501, 0.04); f.at(2701);
  f.at(5699, 0); assert.equal(f.audio.volume, 0.1);
  f.at(5701); assert.equal(f.audio.volume, 0.1);
  f.at(5901); assert.ok(Math.abs(f.audio.volume - 0.8875) < 1e-9);
  f.at(6101); assert.equal(f.audio.volume, 1);
  f.control.cleanup();
});

test('a loud burst shorter than 200ms never triggers ducking', () => {
  const f = fixture();
  f.at(40, 1); f.at(239);
  assert.equal(f.audio.volume, 1);
  f.at(240, 0); f.at(4000);
  assert.equal(f.audio.volume, 1); assert.equal(f.control.snapshot().ducked, false);
  f.control.cleanup();
});

test('separate short bursts do not accumulate toward the 200ms threshold', () => {
  const f = fixture();
  f.at(0, 0.05); f.at(120); f.at(121, 0);
  f.at(250, 0.05); f.at(449);
  assert.equal(f.audio.volume, 1);
  f.at(450); assert.equal(f.audio.volume, 0.1);
  f.control.cleanup();
});

test('a brief noise burst does not extend an existing hold or interrupt release', () => {
  const f = fixture(0.04);
  f.at(200); assert.equal(f.audio.volume, 0.1);
  f.at(240, 0);
  f.at(3100, 1); f.at(3199, 0);
  f.at(3200); assert.equal(f.audio.volume, 0.1);
  f.at(3300, 1); f.at(3399, 0);
  assert.ok(Math.abs(f.audio.volume - (0.1 + 0.9 * (1 - (1 - 199 / 400) ** 3))) < 1e-9);
  f.at(3600); assert.equal(f.audio.volume, 1);
  f.control.cleanup();
});

test('dragging enters manual mode and subsequent activity never overwrites manual volume', () => {
  const f = fixture(0.04);
  f.control.setManualVolume(0.67);
  assert.equal(f.control.snapshot().automatic, false);
  f.at(100, 0.06); assert.equal(f.audio.volume, 0.67);
  f.audio.volume = 0.41;
  f.at(5000, 0); assert.equal(f.audio.volume, 0.41);
  f.control.cleanup();
});

test('manual mode still observes speech so returning to auto respects the latest hold', () => {
  const f = fixture();
  f.control.setManualVolume(0.8);
  f.at(2000, 0.03);
  f.at(2200); f.at(2240, 0);
  f.control.setAutomatic(true);
  assert.equal(f.audio.volume, 0.1);
  f.control.setAutomatic(false);
  f.at(8000); assert.equal(f.audio.volume, 0.1);
  f.control.cleanup();
});

test('reenabling auto while quiet restores normal volume smoothly; native mute is unchanged', () => {
  const f = fixture();
  f.audio.muted = true;
  f.control.setManualVolume(0.4); f.control.setAutomatic(true);
  assert.equal(f.audio.volume, 0.4);
  f.at(400); assert.equal(f.audio.volume, 1); assert.equal(f.audio.muted, true);
  f.control.cleanup();
});

test('invalid control values fail visibly without changing the prior mode or value', () => {
  const f = fixture();
  assert.throws(() => f.control.setManualVolume(NaN), RangeError);
  assert.throws(() => f.control.setAutomatic('true'), TypeError);
  assert.equal(f.control.snapshot().automatic, true); assert.equal(f.audio.volume, 1);
  f.control.cleanup();
});

test('an unexpected sampling error disables automatic writes and preserves its diagnostics', () => {
  const f = fixture(0.04);
  f.sample(NaN);
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].message, /microphone level is invalid/);
  assert.equal(f.control.snapshot().error.stack, f.failures[0].stack);
  assert.equal(f.audio.volume, 1); assert.equal(f.cleared, 1);
  assert.throws(() => f.control.setAutomatic(true), /microphone level is invalid/);
  f.control.setManualVolume(0.3); assert.equal(f.audio.volume, 0.3);
  f.control.cleanup();
});

test('audio-driven levels reconnect only our local branch and never copy microphone audio to output', () => {
  const audio = new Audio(), stream1 = {}, stream2 = {}, nodes = [], processors = [];
  let stream = stream1, time = 0;
  const microphone = { isMuted: false, getInputStream: () => stream, context: { destination: {},
    createScriptProcessor(size) { const p = { size, connect() {}, disconnect() {} }; processors.push(p); return p; },
    createMediaStreamSource(input) {
      const node = { input, connected: false, connect() { this.connected = true; }, disconnect() { this.connected = false; } };
      nodes.push(node); return node;
    },
  } };
  const control = createVoiceDucking({ audioElement: audio, microphone }, {
    now: () => time, stopTimer() {},
  });
  assert.equal(audio.volume, 1); assert.equal(nodes.length, 1);
  const output = new Float32Array(2048).fill(0.7);
  const event = { inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.04) }, outputBuffer: { getChannelData: () => output } };
  processors[0].onaudioprocess(event);
  assert.equal(audio.volume, 1);
  time = 200; processors[0].onaudioprocess(event);
  assert.equal(audio.volume, 0.1); assert.ok(output.every(value => value === 0));
  stream = stream2; time = 240; control.tick();
  assert.equal(nodes.length, 2); assert.equal(nodes[0].connected, false);
  assert.equal(nodes[1].input, stream2); assert.equal(nodes[1].connected, true);
  control.cleanup(); assert.equal(nodes[1].connected, false); assert.equal(audio.volume, 1);
});

test('native module loader discovers current build names and preserves fetch failures', async () => {
  const document = { scripts: [{ src: 'app://-/assets/index-new.js' }] };
  class Native { static start() {} getStream() {} setOutputAudioMuted() {} }
  const fetched = [];
  const value = await loadNativeVoiceMedia(document, {
    fetchModule: async url => { fetched.push(url); return { ok: true, text: async () => url.includes('index-') ? 'import "./app-initial-build.js"' : 'import("./webrtc-session-build.js")' }; },
    importModule: async url => { assert.equal(url, 'app://-/assets/webrtc-session-build.js'); return { RealtimeWebRtcSession: Native }; },
  });
  assert.equal(value, Native); assert.equal(fetched.length, 2);
  const failure = new TypeError('specific loader failure');
  await assert.rejects(loadNativeVoiceMedia(document, { fetchModule: async () => { throw failure; } }), error => error === failure);
  await assert.rejects(loadNativeVoiceMedia(document, { fetchModule: async () => ({ ok: true, text: async () => '' }) }), /app-initial module reference changed/);
});

test('inline app-initial media is located by playback contract, not its minified export', async () => {
  class Native { static start() {} getStream() {} setOutputAudioMuted() {} }
  const imports = [];
  const options = {
    fetchModule: async url => ({ ok: true, text: async () => url.includes('index-') ? 'import "./app-initial-new.js"' : 'class e{static start(){}}' }),
    importModule: async url => { imports.push(url); return { w_: Native, unrelated: class {} }; },
  };
  const document = { scripts: [{ src: 'app://-/assets/index-new.js' }] };
  assert.equal(await loadNativeVoiceMedia(document, options), Native);
  assert.deepEqual(imports, ['app://-/assets/app-initial-new.js']);
  await assert.rejects(loadNativeVoiceMedia(document, { ...options, importModule: async () => ({ broken: class {} }) }), /playback contract changed/);
  const failure = new SyntaxError('native module parse failure');
  await assert.rejects(loadNativeVoiceMedia(document, { ...options, importModule: async () => { throw failure; } }), error => error === failure);
});

test('cold native lazy exports are initialized once without starting audio or a session', async () => {
  let initialized = 0, started = 0, Native;
  function initialize() {
    initialized++;
    Native ||= class {
      static async start() { started++; }
      getStream(){}
      setOutputAudioMuted(){}
    };
  }
  const module = { init: initialize, alias: initialize, get media() { return Native; } };
  const options = {
    fetchModule: async url => ({ ok: true, text: async () => url.includes('index-') ? 'import "./app-initial-new.js"' : '' }),
    importModule: async () => module,
  };
  const document = { scripts: [{ src: 'app://-/assets/index-new.js' }] };
  assert.equal(await loadNativeVoiceMedia(document, options), Native);
  assert.equal(await loadNativeVoiceMedia(document, options), Native);
  assert.equal(initialized, 1); assert.equal(started, 0);
});

test('lazy initialization preserves native failures and rejects ambiguous or missing owners', async () => {
  const failure = new RangeError('specific native initialization failure');
  let Native;
  function initialize() {
    if (failure) throw failure;
    Native = class { static async start() {} getStream(){} setOutputAudioMuted(){} };
  }
  function otherInitialize() {
    Native = class { static async start() {} getStream(){} setOutputAudioMuted(){} };
  }
  const options = {
    fetchModule: async url => ({ ok: true, text: async () => url.includes('index-') ? 'import "./app-initial-new.js"' : '' }),
    importModule: async () => ({ initialize, get media() { return Native; } }),
  };
  const document = { scripts: [{ src: 'app://-/assets/index-new.js' }] };
  await assert.rejects(loadNativeVoiceMedia(document, options), error => error === failure);
  await assert.rejects(loadNativeVoiceMedia(document, { ...options, importModule: async () => ({ initialize, otherInitialize }) }), /playback contract changed/);
  await assert.rejects(loadNativeVoiceMedia(document, { ...options, importModule: async () => ({ unrelated() {} }) }), /playback contract changed/);
});

test('an audio callback failure retains the original exception and stops only our metering branch', () => {
  const audio = new Audio(), failures = [], failure = new RangeError('specific audio-buffer failure');
  let processor, disconnected = false;
  const control = createVoiceDucking({ audioElement: audio, microphone: { getInputStream: () => 'existing-stream', context: {
    destination: {},
    createMediaStreamSource() { return { connect() {}, disconnect() { disconnected = true; } }; },
    createScriptProcessor() { return processor = { connect() {}, disconnect() {} }; },
  } } }, { onError: error => failures.push(error) });
  processor.onaudioprocess({ inputBuffer: { getChannelData() { throw failure; } } });
  assert.equal(failures[0], failure); assert.equal(control.snapshot().error.stack, failure.stack);
  assert.equal(control.snapshot().automatic, false); assert.equal(audio.volume, 1); assert.equal(disconnected, true);
  control.cleanup();
});

test('all injected helpers remain self-contained serializable JavaScript', () => {
  for (const fn of [createVoiceDucking, loadNativeVoiceMedia, installVoiceVolume]) assert.doesNotThrow(() => new Function('return (' + fn.toString() + ')'));
});

test('cleanup after a failed native media load closes owned resources without masking the loader error', async () => {
  const original = new TypeError('native media contract changed'), failures = [];
  let closed = false, disconnected = false, removed = false;
  const win = { MutationObserver: class { observe() {} disconnect() { disconnected = true; } },
    BroadcastChannel: class { postMessage() {} close() { closed = true; } } };
  const document = { defaultView: win, documentElement: {}, head: { append() {} },
    querySelectorAll: () => [], createElement: () => ({ remove() { removed = true; } }) };
  const control = installVoiceVolume(document, async () => { throw original; }, createVoiceDucking, error => failures.push(error));
  assert.equal(await control.ready, false); assert.equal(failures[0], original);
  assert.doesNotThrow(() => control.cleanup());
  assert.equal(closed, true); assert.equal(disconnected, true); assert.equal(removed, true);
  assert.equal(win.__CODEX_VOICE_VOLUME__, undefined);
});

test('explicit reinstallation reloads failed controls but preserves a healthy live owner', async () => {
  const failure = new Error('initial native load failed');
  const win = { MutationObserver: class { observe() {} disconnect() {} },
    BroadcastChannel: class { postMessage() {} close() {} } };
  const document = { defaultView: win, documentElement: {}, head: { append() {} },
    querySelectorAll: () => [], createElement: () => ({ remove() {} }) };
  const failed = installVoiceVolume(document, async () => { throw failure; }, createVoiceDucking);
  assert.equal(await failed.ready, false);
  class Native { static start() {} }
  const start = Native.start;
  const restored = installVoiceVolume(document, async () => Native, createVoiceDucking);
  assert.notEqual(restored, failed); assert.equal(await restored.ready, true);
  assert.equal(restored.status().error, null);
  const owner = Native.start;
  const same = installVoiceVolume(document, () => { throw new Error('healthy owner must not reload'); }, createVoiceDucking);
  assert.equal(same, restored); assert.equal(Native.start, owner);
  restored.cleanup(); assert.equal(Native.start, start);
});
