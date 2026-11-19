import { createNativeAssetReader, loadNativeAppServices } from './renderer.mjs';
import { nativeQuitItem } from './application-menu.mjs';
import { requestRuntime } from './runtime.mjs';

export async function quitNativeApplication(stateDirectory, { request = requestRuntime, fetchImpl = fetch, Socket = WebSocket } = {}) {
  const runtime = await request(stateDirectory, 'status');
  if (!runtime.cdp?.connected) throw new Error('The running Codex has no connected Toolkit debug session.');
  const response = await fetchImpl(`http://127.0.0.1:${runtime.cdp.port}/json/list`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error('Codex window discovery failed: HTTP ' + response.status);
  const targets = await response.json();
  const page = targets.find(item => item.type === 'page' && item.url === 'app://-/index.html');
  if (!page) throw new Error('No Codex chat window is available for native quit.');
  const url = new URL(page.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== runtime.cdp.port || url.username || url.password) throw new Error('Codex returned a debug endpoint outside its local session.');
  const expression = `(async()=>{const assets=(${createNativeAssetReader.toString()})(document);const services=await (${loadNativeAppServices.toString()})(document,{assets});const item=(${nativeQuitItem.toString()})(await services.applicationMenu.getSnapshot());await services.applicationMenu.invokeItem(item.nativeCommandId);return {quitRequested:true};})()`;
  return new Promise((resolve, reject) => {
    const socket = new Socket(url);
    let settled = false, sent = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('Native quit dispatch exceeded 15 seconds.')), 15000);
    socket.addEventListener('error', event => {
      const error = event.error || new Error('Codex debug connection failed.');
      // Native quit can close Chromium's socket before its RPC reply; process exit is verified by the worker.
      if (sent) finish(null, { quitRequested: false, connectionClosedBeforeAcknowledgement: true, connectionError: { name: error.name, message: error.message, stack: error.stack } });
      else finish(error);
    }, { once: true });
    socket.addEventListener('close', () => sent ? finish(null, { quitRequested: false, connectionClosedBeforeAcknowledgement: true }) : finish(new Error('Codex closed before native quit was dispatched.')), { once: true });
    socket.addEventListener('open', () => { socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); sent = true; }, { once: true });
    socket.addEventListener('message', event => {
      try {
        const value = JSON.parse(event.data); if (value.id !== 1) return;
        if (value.error || value.result?.exceptionDetails) throw new Error(value.error?.message || value.result.exceptionDetails.exception?.description || value.result.exceptionDetails.text);
        if (value.result?.result?.value?.quitRequested !== true) throw new Error('Native quit dispatch was not confirmed.');
        finish(null, value.result.result.value);
      } catch (error) { finish(error); }
    });
  });
}
