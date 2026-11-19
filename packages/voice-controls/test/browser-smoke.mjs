import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { kitPayload } from 'codex-toolkit-core/kits';
import voiceKit from '../kits/voice-volume/index.mjs';
const executable = process.argv[2];
if (!path.isAbsolute(executable || '')) throw new Error('Pass an absolute path to an installed Edge executable.');
const directory = path.resolve('Temp', 'browser-' + randomUUID()); await fs.mkdir(directory, { recursive: true });
const source = await fs.readFile(new URL('../src/voice-volume.mjs', import.meta.url), 'utf8'), renderer = await fs.readFile(new URL('../src/renderer.mjs', import.meta.url), 'utf8');
const core = await fs.readFile(new URL(import.meta.resolve('codex-toolkit-core/renderer')), 'utf8');
const fixtureKit = { ...voiceKit, helpers: { ...voiceKit.helpers,
  loadNativeVoiceMedia: async () => window.__CDTK_FIXTURE_VOICE_MEDIA__,
  createVoiceDucking: (media, options) => window.__CDTK_FIXTURE_DUCKING__(media, options) } };
async function checks(payload, colorsOnly) {
 const checks = [], errors = [], reports = [];
 const record = (name, passed) => { checks.push({ name, passed: Boolean(passed) }); if (!passed) throw new Error(name); };
 const wait = predicate => predicate() ? Promise.resolve() : new Promise(resolve => { const observer = new MutationObserver(() => { if (predicate()) { observer.disconnect(); resolve(); } }); observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true }); });
 const output = value => { const node = document.getElementById('result'); node.setAttribute('data-result', encodeURIComponent(JSON.stringify(value))); node.textContent = JSON.stringify(value); };
 try {
  const helpers = await import('/voice.mjs'), { installVoiceRenderer } = await import('/renderer.mjs');
  const audio = document.createElement('audio'), lifecycle = new EventTarget(), media = { audioElement: audio, dataChannel: lifecycle };
  let time = 0, level = 0, control;
  class Media { static async start() { return { session: media }; } }
  const original = Media.start;
  window.__CDTK_VOICE_BRIDGE__ = value => reports.push(JSON.parse(value));
  installVoiceRenderer(window, { epoch: 'fixture' }, { ...helpers, loadNativeVoiceMedia: async () => Media, createVoiceDucking: (media, options) => {
   control = helpers.createVoiceDucking(media, { ...options, sampleLevel: () => level, now: () => time }); return control;
  } });
  record('cold bootstrap does not inspect playback before the native page mounts', Media.start === original && reports.at(-1).status === null);
  const main=document.createElement('main');main.className='main-surface';main.appendChild(document.getElementById('orb'));document.body.appendChild(main);
  await window.__CODEX_DESKTOP_TOOLKIT_VOICE__.refresh();
  record('native class is wrapped without starting a call or requesting a microphone', Media.start !== original && !control && reports.at(-1).status.ready);
  const frame = document.createElement('iframe'); frame.srcdoc = '<div style="position:relative;height:100px" data-testid="realtime-voice-stage-orb"></div>';
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true })); document.body.appendChild(frame); await loaded;
  class RemoteMedia { static async start() {} }
  const remoteOriginal = RemoteMedia.start;
  const remote = helpers.installVoiceVolume(frame.contentDocument, async () => RemoteMedia, helpers.createVoiceDucking, error => errors.push(error.message)); await remote.ready;
  const remoteWait = predicate => predicate() ? Promise.resolve() : new Promise(resolve => { const observer = new MutationObserver(() => { if (predicate()) { observer.disconnect(); resolve(); } }); observer.observe(frame.contentDocument.documentElement, { subtree: true, childList: true, attributes: true }); });
  await Media.start(); await remoteWait(() => !frame.contentDocument.querySelector('.codex-voice-volume').hidden);
  const node = document.querySelector('.codex-voice-volume'), remoteNode = frame.contentDocument.querySelector('.codex-voice-volume');
  record('playback owner and remote orb share automatic mode', !node.hidden && node.querySelector('[type=checkbox]').checked && remoteNode.querySelector('[type=checkbox]').checked);
  const orbRect = document.querySelector('[data-testid]').getBoundingClientRect(), controlRect = node.getBoundingClientRect();
  record('slider position and text size preserve the existing appearance', Math.abs(controlRect.top - (orbRect.bottom - 15)) < 1 && getComputedStyle(node).fontSize === '12px');
  document.documentElement.style.colorScheme = 'dark';
  const darkVoice = [getComputedStyle(node).color, getComputedStyle(node.querySelector('[type=checkbox]')).accentColor];
  document.documentElement.style.colorScheme = 'light';
  const lightVoice = [getComputedStyle(node).color, getComputedStyle(node.querySelector('[type=checkbox]')).accentColor];
  node.setAttribute('data-error', 'true');
  const thumbRule = [...document.getElementById('codex-voice-volume-style').sheet.cssRules].find(rule => rule.selectorText?.endsWith('::-webkit-slider-thumb'));
  record('voice text, thumb, checkbox and error switch to light colors', darkVoice.every((color, index) => color !== lightVoice[index]) && getComputedStyle(node).color === 'rgb(185, 28, 28)' && thumbRule?.style.backgroundColor === 'light-dark(rgb(37, 99, 184), rgb(96, 165, 250))');
  node.removeAttribute('data-error'); document.documentElement.style.colorScheme = 'dark';
  record('Chromium accepts the explicit visible slider track', [...document.getElementById('codex-voice-volume-style').sheet.cssRules].some(rule => rule.selectorText?.endsWith('::-webkit-slider-runnable-track') && rule.style.backgroundColor === 'rgb(100, 116, 139)'));
  if (colorsOnly) { window.__CODEX_DESKTOP_TOOLKIT_VOICE__.cleanup(); remote.cleanup(); output({ ok: true, checks }); return; }
  level = 1; control.tick(); time = 199; control.tick(); record('short loud bursts leave playback unchanged', audio.volume === 1);
  time = 200; control.tick(); await remoteWait(() => remoteNode.querySelector('output').textContent === '10%');
  record('sustained sound ducks local playback and updates the remote control', audio.volume === 0.1 && remoteNode.querySelector('output').textContent === '10%');
  const slider = remoteNode.querySelector('[type=range]'); slider.value = '55'; slider.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }));
  await wait(() => node.querySelector('output').textContent === '55%');
  time = 700; control.tick(); record('remote dragging switches to manual without later automatic overwrite', audio.volume === 0.55 && !node.querySelector('[type=checkbox]').checked && !remoteNode.querySelector('[type=checkbox]').checked);
  await remoteWait(() => remote.state()?.automatic === false && remote.state()?.volume === 0.55 && remote.state()?.ducked === false);
  const automatic = remoteNode.querySelector('[type=checkbox]'); automatic.checked = true; automatic.dispatchEvent(new frame.contentWindow.Event('change', { bubbles: true }));
  await wait(() => node.querySelector('[type=checkbox]').checked && node.querySelector('output').textContent === '10%');
  level = 0; time = 3699; control.tick(); record('silence holds the low volume for three seconds', audio.volume === 0.1);
  time = 3700; control.tick(); time = 4100; control.tick(); record('automatic mode smoothly restores the original volume', audio.volume === 1);
  lifecycle.dispatchEvent(new Event('close')); await remoteWait(() => remoteNode.hidden);
  record('native call closure ends local and remote state', node.hidden && remoteNode.hidden && reports.at(-1).status.active === false);
  window.__CODEX_DESKTOP_TOOLKIT_VOICE__.cleanup(); remote.cleanup();
  record('cleanup restores native start methods and removes only owned UI', Media.start === original && RemoteMedia.start === remoteOriginal && !document.querySelector('.codex-voice-volume') && !frame.contentDocument.querySelector('.codex-voice-volume'));
  record('no unexpected error is hidden', errors.length === 0 && reports.every(row => !row.error));
  window.__CDTK_FIXTURE_VOICE_MEDIA__ = Media;
  window.__CDTK_FIXTURE_DUCKING__ = (media, options) => { control = helpers.createVoiceDucking(media, { ...options, sampleLevel: () => level, now: () => time }); return control; };
  await (0,eval)(payload); const host=window.__CODEXTOPKITS_FEATURE_HOST__;
  await window.__CODEXTOPKITS_VOICE__.refresh(); await Media.start();
  record('standalone voice Kit connects the existing synthetic playback', Media.start !== original && window.__CODEXTOPKITS_VOICE__.status().active);
  record('Kit forwards active-call status to the existing voice management bridge', reports.at(-1)?.status?.active === true);
  const kitNode=document.querySelector('.codex-voice-volume'), kitSlider=kitNode.querySelector('[type=range]'), kitCheckbox=kitNode.querySelector('[type=checkbox]');
  kitSlider.value='55';kitSlider.dispatchEvent(new Event('input',{bubbles:true}));
  host.setHostState({languagePreference:{mode:'fixed',locale:'zh-Hans'}});
  record('locale change keeps the existing manual control and playback',document.querySelector('.codex-voice-volume')===kitNode&&kitNode.querySelector('[type=range]')===kitSlider&&kitSlider.value==='55'&&!kitCheckbox.checked&&audio.volume===0.55&&kitSlider.getAttribute('aria-label')==='语音播放音量'&&kitNode.querySelector('label').textContent==='自动');
  host.setHostState({languagePreference:{mode:'fixed',locale:'en'}});
  record('locale change updates accessible and visible labels in place',kitSlider.getAttribute('aria-label')==='Voice playback volume'&&kitCheckbox.getAttribute('aria-label')==='Automatic voice volume ducking'&&kitNode.querySelector('label').textContent==='Auto'&&kitSlider.value==='55'&&!kitCheckbox.checked);
  let refused=false;try{await host.checkRestart();}catch(error){refused=error.message.includes('End the voice call');}
  record('restart preflight preserves the active voice control',refused&&window.__CODEXTOPKITS_VOICE__.status().active&&Media.start!==original);
  lifecycle.dispatchEvent(new Event('close'));await host.checkRestart();await host.close();
  record('after the call ends the Kit host can close and restores native playback',Media.start===original&&!document.querySelector('.codex-voice-volume'));
  record('voice management bridge is told when the Kit is disabled', reports.at(-1)?.disabled === true);
  output({ ok: true, checks, observedAt: new Date().toISOString(), audio: 'synthetic volume object; no device or sound opened' });
 } catch (error) { output({ ok: false, checks, errors, error: { name: error.name, message: error.message, stack: error.stack }, reports: reports.slice(-3) }); }
}
const html = '<!doctype html><meta charset="utf-8"><script type="importmap">{"imports":{"codex-toolkit-core/renderer":"/core.mjs"}}</script><style>body{background:#181818;color:#eee}#orb{position:relative;height:100px;width:300px}</style><div id="orb" data-testid="realtime-voice-stage-orb"></div><pre id="result">running</pre><script type="module">(' + checks.toString() + ')(' + JSON.stringify(kitPayload([fixtureKit])) + ',' + JSON.stringify(process.argv[3] === '--colors-only') + ');</script>';
const routes = new Map([['/voice.mjs', source], ['/renderer.mjs', renderer], ['/core.mjs', core]]);
const server = http.createServer((request, response) => {
 if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html, 'utf8'); }
 else if (routes.has(request.url)) { response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(routes.get(request.url), 'utf8'); }
 else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
 const { stdout, stderr } = await promisify(execFile)(executable, ['--headless=new', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(directory, 'profile'), '--dump-dom', '--virtual-time-budget=10000', 'http://127.0.0.1:' + server.address().port], { windowsHide: true, encoding: 'utf8', maxBuffer: 3 * 1024 * 1024, timeout: 60000 });
 await fs.writeFile(path.join(directory, 'dom.html'), stdout, 'utf8'); await fs.writeFile(path.join(directory, 'stderr.log'), stderr, 'utf8');
 const match = stdout.match(/<pre\b[^>]*\bid="result"[^>]*\bdata-result="([^"]+)"/); assert.ok(match, 'Browser checks did not finish; inspect ' + directory);
 const result = JSON.parse(decodeURIComponent(match[1])); await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
 assert.equal(result.ok, true, JSON.stringify(result)); console.log(JSON.stringify({ ok: true, checks: result.checks.length, directory, observedAt: new Date().toISOString() }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
