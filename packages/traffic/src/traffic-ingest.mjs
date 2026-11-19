import { watch, watchFile, unwatchFile, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { importWindowsSample } from './traffic-windows-bridge.mjs';

// Both sources share the controller's SQLite owner. Each committed cursor and
// its records form one transaction; incomplete UTF-8/JSON tails stay uncommitted.
export class TrafficFileImporter {
  constructor({ log, filename, source, consume, onError, pollMs = 0 }) {
    Object.assign(this, { log, filename, source, consume, onError, pollMs });
    log.db.exec(`CREATE TABLE IF NOT EXISTS traffic_import_cursor (
      source TEXT PRIMARY KEY, identity TEXT NOT NULL, position INTEGER NOT NULL)`);
    this.cursor = log.db.prepare('INSERT OR REPLACE INTO traffic_import_cursor VALUES (?,?,?)');
    this.decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  }
  start() {
    if (this.pollMs) {
      this.statListener = (current, previous) => { if (current.size !== previous.size || current.ino !== previous.ino) this.schedule(); };
      watchFile(this.filename, { interval: this.pollMs, persistent: false }, this.statListener);
    } else {
      this.watcher = watch(dirname(this.filename), (_event, name) => {
        if (!name || String(name) === basename(this.filename)) this.schedule();
      });
      this.watcher.on('error', error => this.fail(error));
    }
    this.schedule();
    return this;
  }
  fail(error) {
    if (this.failed || this.closed) return;
    this.failed = true; this.watcher?.close();
    if (this.statListener) unwatchFile(this.filename, this.statListener);
    this.onError(error, this.source);
  }
  schedule() {
    if (this.closed || this.failed) return;
    this.dirty = true;
    if (!this.running) this.running = this.drain().catch(error => this.fail(error)).finally(() => {
      this.running = null;
      if (this.dirty && !this.closed && !this.failed) this.schedule();
    });
  }
  async drain() {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      let file;
      try { file = await open(this.filename, 'r'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.log.coverage(this.source, 'gap', '等待流量记录文件；此前保存的数据不受影响。');
        continue;
      }
      try {
        const stat = await file.stat({ bigint: true }), identity = `${stat.dev}:${stat.ino}`;
        if (identity !== this.identity) {
          const saved = this.log.db.prepare('SELECT * FROM traffic_import_cursor WHERE source=?').get(this.source);
          this.identity = identity;
          this.position = saved?.identity === identity ? saved.position : 0;
          this.pending = Buffer.alloc(0);
        }
        const size = Number(stat.size);
        if (size < this.position) throw new Error(`Traffic source was truncated: ${this.filename}`);
        while (this.position < size && !this.closed) {
          const bytes = Buffer.alloc(Math.min(65536, size - this.position));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, this.position);
          if (!bytesRead) throw new Error(`Traffic source ended before its reported size: ${this.filename}`);
          this.position += bytesRead;
          const batch = Buffer.concat([this.pending, bytes.subarray(0, bytesRead)]);
          const end = batch.lastIndexOf(10);
          if (end >= 0) {
            const text = this.decoder.decode(batch.subarray(0, end + 1));
            this.log.db.exec('BEGIN');
            try {
              for (let line of text.split('\n')) {
                if (line.endsWith('\r')) line = line.slice(0, -1);
                if (line) this.consume(JSON.parse(line));
              }
              this.cursor.run(this.source, identity, this.position - (batch.length - end - 1));
              this.log.db.exec('COMMIT');
            } catch (error) { this.log.db.exec('ROLLBACK'); throw error; }
          }
          this.pending = batch.subarray(end + 1);
          await setImmediate();
        }
      } finally { await file.close(); }
    }
  }
  async close() {
    this.closed = true; this.watcher?.close();
    if (this.statListener) unwatchFile(this.filename, this.statListener);
    await this.running;
  }
}

export function startWindowsImport({ log, filename, onError }) {
  log.coverage('windows-network', 'info', '正在接入 Windows 进程流量记录。');
  // The long-held .NET writer grows this file without emitting directory-change
  // notifications on this host. Stat only; read nothing when its size is stable.
  return new TrafficFileImporter({ log, filename, source: 'windows-network', onError, pollMs: 1000,
    consume: sample => {
      if (sample.type === 'sample' && sample.status === 'active') importWindowsSample(log, sample);
      else if (sample.status === 'error' || sample.type === 'error') log.coverage('windows-network', 'error', sample.error || 'Windows 流量记录已报告错误。');
      else if (sample.status === 'stopped') log.coverage('windows-network', 'gap', 'Windows 流量记录已停止。');
    },
  }).start();
}

export function startModelImport({ log, filename, onError }) {
  let state;
  try { state = JSON.parse(readFileSync(join(dirname(filename), 'state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  log.coverage('model-threads', state?.metricsVersion === 1 ? 'active' : 'gap', state?.metricsVersion === 1
    ? '已按原生线程标识记录模型通道；统计范围与限制见下方会话表。'
    : '当前转发服务尚未启用线程流量计量；下次完整退出并主题启动后生效。已有进程流量统计不受影响。');
  return new TrafficFileImporter({ log, filename, source: 'model-threads', onError,
    consume: entry => {
      if (entry.event === 'ready') log.coverage('model-threads', entry.metricsVersion === 1 ? 'active' : 'gap', entry.metricsVersion === 1
        ? '已按原生线程标识记录模型通道：HTTP 压缩正文／WebSocket 压缩帧，以及首次图片上传；不含 TLS、TCP、IP 和文件 API 开销。'
        : '当前转发服务尚未启用线程流量计量；下次完整退出并主题启动后生效。');
      if (entry.event === 'model-traffic') {
        if (entry.metricsVersion !== 1) throw new Error('Unsupported model traffic metrics version.');
        log.model(entry.record);
        if (entry.record.measurementError || entry.record.attributionError) log.coverage('model-threads', 'error', '部分模型流量存在计量或线程归属缺口，详见对应连接记录。');
      }
    },
  }).start();
}
