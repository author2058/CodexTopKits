import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateMap, ThemeConfigError } from './model.mjs';

export async function openThemeStore({ filename, defaultMap, changed, failed }) {
  if (!path.isAbsolute(filename)) throw new ThemeConfigError('主题配置文件必须使用绝对路径。');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  let map;
  try { map = validateMap(decode(await fs.readFile(filename))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    map = validateMap(defaultMap);
    await fs.writeFile(filename, JSON.stringify(map, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  }
  let tail = Promise.resolve(), closed = false;
  const queue = (operation, external = false) => {
    const next = tail.then(operation);
    tail = next.catch(error => { if (external || !(error instanceof ThemeConfigError)) failed(error); });
    return next;
  };
  const update = change => queue(async () => {
    if (closed) throw new Error('主题设置服务已停止。');
    const current = validateMap(decode(await fs.readFile(filename)));
    const next = validateMap(change(current));
    const temporary = filename + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', 'utf8');
    await fs.rename(temporary, filename);
    map = next; changed(map);
    return map;
  });
  const watcher = watch(path.dirname(filename), { encoding: 'utf8' }, (_event, name) => {
    if (closed || name !== path.basename(filename)) return;
    void queue(async () => {
      const next = validateMap(decode(await fs.readFile(filename)));
      if (JSON.stringify(next) !== JSON.stringify(map)) { map = next; changed(map); }
    }, true).catch(() => { /* The queue already reports this exact error through failed. */ });
  });
  watcher.on('error', failed);
  return {
    get map() { return map; },
    assign({ kind, key, value }) {
      if (!['project', 'task'].includes(kind) || typeof key !== 'string' || !key || key.length > 300) return Promise.reject(new ThemeConfigError('请选择有效的工程或任务。'));
      const section = kind === 'project' ? 'projects' : 'tasks';
      return update(current => ({ ...current, [section]: { ...current[section], [key]: value } }));
    },
    appearance({ enabledColors, uiFontSizeOverride }) { return update(current => ({ ...current, enabledColors, uiFontSizeOverride })); },
    async close() { closed = true; watcher.close(); await tail; },
  };
}
