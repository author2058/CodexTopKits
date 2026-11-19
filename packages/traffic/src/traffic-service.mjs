import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TrafficLog, TrafficRecorder } from './traffic-log.mjs';
import { startWindowsImport } from './traffic-ingest.mjs';

const exec = promisify(execFile);

// This plugin instance is the only SQLite writer for all of its collection sources.
export async function createTrafficService({ stateDirectory, cdp, cdpPort, windowsDirectory, connections = false, powershellPath = 'pwsh', changed, diagnostic, initialCapture = null }) {
  if (cdpPort !== undefined && (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535)) throw new Error('cdpPort must be an integer from 1024 to 65535.');
  if (windowsDirectory !== undefined && !path.isAbsolute(windowsDirectory)) throw new Error('windowsDirectory must be absolute.');
  const log = new TrafficLog(path.join(stateDirectory, 'traffic.sqlite'));
  const errors = new Map();
  const connectionAbort = new AbortController();
  let recorder, windowsImport, connectionsTimer, connectionsWork, connecting, closed = false, modelFailed = false, cdpRequested = initialCapture?.requested === true;
  const initialPaused = initialCapture?.paused === true;
  const changedErrors = () => changed([...errors.values()], [...errors].map(([key, error]) => ({ key, message: error.message })));
  const recovered = source => { if (errors.delete(source)) changedErrors(); };
  const fail = (error, source) => {
    if (errors.get(source)?.message === error.message) return;
    errors.set(source, error);
    changedErrors(); diagnostic({ event: 'traffic-failed', source, name: error.name, message: error.message, stack: error.stack });
    try { log.coverage(source, 'error', error.name + ': ' + error.message); }
    catch (writeError) { diagnostic({ event: 'traffic-diagnostic-write-failed', message: writeError.message, stack: writeError.stack, cause: error.stack }); }
  };
  log.coverage('model-threads', 'info', '模型计量已就绪，等待实际请求；没有记录不表示流量为 0。');
  log.coverage('chromium', cdpPort ? 'info' : 'disabled', cdpPort ? '等待应用请求后连接配置的本机调试端口。' : 'Chromium 采集未启用；模型计量不依赖 CDP。');
  log.coverage('windows-network', windowsDirectory ? 'info' : 'disabled', windowsDirectory ? '正在接入选定目录的 Windows 流量记录。' : 'Windows 内核采集未启用；启用采集器需要管理员确认。');
  log.coverage('capture-boundary', 'info', '不同统计层可能重叠，不能相加；逻辑 JSON 缩短不等于运营商账单节省。');
  const readConnections = async () => {
    const script = fileURLToPath(new URL('./traffic-connections.ps1', import.meta.url));
    const { stdout } = await exec(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-ToolkitProcessId', String(process.pid)], { windowsHide: true, encoding: 'buffer', signal: connectionAbort.signal });
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout));
  };
  const sampleConnections = async () => {
    try { const rows = await readConnections(); if (!closed) { log.connections(rows); log.coverage('connections', 'active', '每 30 秒记录进程连接；连接表不提供上传下载字节，可能漏掉短连接。'); } }
    catch (error) { if (!closed) fail(error, 'connections'); return; }
    if (!closed) connectionsTimer = setTimeout(() => { connectionsWork = sampleConnections(); }, 30000);
  };
  const startCdp = () => {
    if (connecting) return connecting;
    if (!cdpPort) return Promise.reject(new Error('Chromium capture is not configured.'));
    connecting = (async () => {
      const paused = recorder ? recorder.paused === true : initialPaused;
      if (recorder) await recorder.close();
      recorder = new TrafficRecorder({ log, cdp, port: cdpPort, signal: connectionAbort.signal, onError: fail, onDiagnostic: diagnostic, onRecovered: recovered });
      recorder.paused = paused;
      await recorder.start();
    })().catch(error => { if (!closed) fail(error, 'chromium'); throw error; }).finally(() => { connecting = null; });
    return connecting;
  };
  const unsubscribeReconnect = cdp?.onReconnect(async () => {
    if (!closed && cdpRequested) return startCdp();
  });
  try {
    if (windowsDirectory) {
      await fs.mkdir(windowsDirectory, { recursive: true });
      windowsImport = startWindowsImport({ log, filename: path.join(windowsDirectory, 'windows-network.jsonl'), onError: fail });
    }
    if (connections) connectionsWork = sampleConnections();
    else log.coverage('connections', 'disabled', '进程连接采样未启用。');
    if (cdpRequested) void startCdp().catch(error => console.error('Chromium capture restore failed:', error));
    return {
      log,
      captureState: () => ({ requested: cdpRequested, paused: recorder ? recorder.paused === true : initialPaused }),
      record(entry) {
        if (closed) return;
        if (cdpPort && !cdpRequested && ['http-send', 'websocket-send'].includes(entry.event)) {
          cdpRequested = true;
          // Failure is already recorded in health; it never changes the model request.
          void startCdp().catch(error => console.error('Chromium capture failed:', error));
        }
        if (modelFailed || entry.event !== 'model-traffic') return;
        try {
          if (entry.metricsVersion !== 1) throw new Error('Unsupported model traffic metrics version.');
          log.db.exec('SAVEPOINT model_record');
          try { log.model(entry.record); log.db.exec('RELEASE model_record'); }
          catch (error) { log.db.exec('ROLLBACK TO model_record; RELEASE model_record'); throw error; }
          if (entry.record.measurementError || entry.record.attributionError) fail(new Error('Model traffic coverage gap: ' + (entry.record.measurementError || entry.record.attributionError)), 'model-metrics');
          log.coverage('model-threads', entry.record.measurementError || entry.record.attributionError ? 'error' : 'active',
            entry.record.measurementError || entry.record.attributionError ? '部分模型计量或归属存在缺口，详见对应连接。' : '已记录实际模型通道字节、首次图片上传和缓存复用；不包含 TLS、TCP、IP 或文件 API 开销。');
        } catch (error) { modelFailed = true; fail(error, 'model-threads'); }
      },
      query(filters) { recorder?.flushFrames(); return log.query(filters); },
      async check() {
        if (!cdpPort || !cdpRequested) return;
        if (connecting) await connecting;
        if (closed) return;
        if (!recorder?.client || recorder.client.closed) await startCdp();
        else await Promise.all(recorder.client.targets().map(info => recorder.attachObserved(info)));
        const targets = new Set(recorder.client.targets().map(info => info.targetId));
        for (const source of errors.keys()) if (source.startsWith('page-target:') && !targets.has(source.slice('page-target:'.length))) recorder.recovered(source, '采集目标已关闭。');
        if (errors.has('chromium') && !recorder.paused && !recorder.tracing) await recorder.startTrace();
      },
      async setCapture(enabled) {
        if (typeof enabled !== 'boolean') throw new Error('Capture enabled must be boolean.');
        cdpRequested = true;
        if (enabled && (!recorder?.client || recorder.client.closed)) await startCdp();
        if (!recorder) throw new Error('Chromium capture is not configured.');
        return recorder.setTracing(enabled);
      },
      async close() {
        closed = true; unsubscribeReconnect?.(); clearTimeout(connectionsTimer); connectionAbort.abort();
        const results = await Promise.allSettled([connecting, connectionsWork, windowsImport?.close()]);
        const failures = results.filter(item => item.status === 'rejected' && item.reason !== connectionAbort.signal.reason).map(item => item.reason);
        try { await recorder?.close(); } catch (error) { failures.push(error); }
        try { log.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Traffic shutdown failed.', { cause: failures[0] });
      },
    };
  } catch (error) { unsubscribeReconnect?.(); log.close(); throw error; }
}
