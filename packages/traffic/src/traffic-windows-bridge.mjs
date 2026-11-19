import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function readWindowsSnapshot(directory) {
  const file = await open(resolve(directory, 'windows-network.jsonl'), 'r');
  try {
    const { size } = await file.stat();
    let start = Math.max(0, size - 65536);
    while (true) {
      const bytes = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
      const end = bytes.lastIndexOf(10, bytesRead - 1);
      const previous = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
      if (end >= 0 && (previous >= 0 || start === 0)) {
        const line = bytes.subarray(previous + 1, end);
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      }
      if (start === 0) throw new Error('Windows network log has no complete record yet.');
      start = Math.max(0, start - 65536);
    }
  } finally { await file.close(); }
}

export function importWindowsSample(log, sample) {
  if (sample.type !== 'sample' || sample.status !== 'active') throw new Error(sample.error || 'Windows network monitor is not active.');
  if (!Number.isSafeInteger(sample.at) || !sample.data?.session || !Array.isArray(sample.data.rows)) throw new Error('Invalid Windows network sample.');
  log.db.exec('CREATE TABLE IF NOT EXISTS traffic_windows_imported(session TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(session,at))');
  log.db.exec('SAVEPOINT windows_sample');
  try {
    const inserted = log.db.prepare('INSERT OR IGNORE INTO traffic_windows_imported VALUES (?,?)').run(sample.data.session, sample.at);
    if (Number(inserted.changes)) for (const row of sample.data.rows) {
      if (!Number.isSafeInteger(row.pid) || typeof row.remote !== 'string' || !['TCP', 'UDP'].includes(row.protocol)) throw new Error('Invalid Windows network row.');
      log.bytes(sample.at, 'windows-network', row.loopback ? 'local' : 'all-codex', `${row.protocol} ${row.remote}`, row.pid, row.up, row.down, row.events);
    }
    const lost = sample.data.eventsLost + sample.data.buffersLost;
    log.coverage('windows-network', lost ? 'error' : 'active', lost
      ? `Windows 网络事件有丢失：事件 ${sample.data.eventsLost}，缓冲区 ${sample.data.buffersLost}。字节数不完整。`
      : 'Windows 内核已记录 Codex 进程树的 TCP／UDP 收发字节，包含原生 codex.exe；本机回环另列，不与 Chromium 或代理进程计数相加。', sample.at);
    log.coverage('native-wire', 'info', '原生进程的网络字节见 Windows 内核统计层；该统计层不保存请求正文，不能仅凭 IP 区分同一原生进程内的线程。');
    log.db.exec('RELEASE windows_sample');
    return Boolean(inserted.changes);
  } catch (error) { log.db.exec('ROLLBACK TO windows_sample; RELEASE windows_sample'); throw error; }
}

// The cap is deliberately shared by every Codex window, not inferred per-thread.
export function experimentGate(sample, baseline, now = Date.now()) {
  if (sample.status !== 'active' || sample.type !== 'sample') return { stop: true, reason: 'monitor-not-active' };
  if (now - sample.at > 5000) return { stop: true, reason: 'monitor-stale' };
  if (sample.data.session !== baseline.session || sample.data.eventsLost || sample.data.buffersLost) return { stop: true, reason: 'monitor-coverage-changed' };
  const up = sample.data.up - baseline.up + (baseline.carriedUp || 0), down = sample.data.down - baseline.down + (baseline.carriedDown || 0);
  if (![up, down].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Windows network totals moved backwards.');
  const elapsedMs = now - baseline.started;
  return { stop: up + down >= 50000000 || elapsedMs >= 1200000,
    reason: up + down >= 50000000 ? '50MB' : elapsedMs >= 1200000 ? '20min' : null, up, down, total: up + down, elapsedMs };
}

export function windowsMonitorHealth(sample, now = Date.now()) {
  if (sample.type !== 'sample' || sample.status !== 'active') throw new Error(sample.error || 'Windows network monitor is not active.');
  if (!Number.isSafeInteger(sample.at)) throw new Error('Invalid Windows network sample timestamp.');
  return now - sample.at > 5000 ? 'stale' : 'active';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error('Windows 流量已改由主题控制器自动导入，不再启动独立数据库写入程序。需要恢复采集时，请在主题管理器重启控制器。');
}
