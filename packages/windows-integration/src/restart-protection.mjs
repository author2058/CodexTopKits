import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function createRestartProtection({ processId, port, powershellPath, signal, log }, services = {}) {
  const execute = services.execute || promisify(execFile), now = services.now || Date.now;
  const sleep = services.sleep || (ms => delay(ms, undefined, { signal }));
  const script = fileURLToPath(new URL('./set-codex-restart.ps1', import.meta.url));
  let operation = null, status = { registered: false, hookInstalled: false, hookVerified: false };
  const protect = () => {
    if (operation) return operation;
    operation = (async () => {
      const deadline = now() + 60000; let waitingLogged = false;
      for (;;) {
        signal?.throwIfAborted();
        try {
          const { stdout } = await execute(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-CdpPort', String(port), '-ProcessId', String(processId)], { encoding: 'utf8', windowsHide: true });
          const value = JSON.parse(stdout);
          if (value.error) throw Object.assign(new Error(value.error.message), value.error);
          if (value.registered !== true || value.hookInstalled !== true || value.hookVerified !== true || value.pid !== processId) throw new Error('官方更新后的调试参数保护未通过读回确认。');
          status = value; await log({ event: 'restart-registration-confirmed', ...value }); return value;
        } catch (error) {
          if (error.code !== 'RESTART_NOT_REGISTERED' || signal?.aborted) throw error;
          if (now() >= deadline) { operation = null; throw error; }
          if (!waitingLogged) { waitingLogged = true; await log({ event: 'restart-registration-pending', name: error.name, message: error.message, stack: error.stack, code: error.code, hresult: error.hresult }); }
          await sleep(Math.min(1000, deadline - now()));
        }
      }
    })();
    return operation;
  };
  return { protect, status: () => status, settled: () => operation };
}
