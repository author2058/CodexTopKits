import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function launchReadAloud(filePath, cwd, powershellPath, execute = promisify(execFile)) {
  if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.md') throw new Error('朗读只支持 Markdown（.md）文件。');
  if (!path.isAbsolute(filePath) && !(typeof cwd === 'string' && path.isAbsolute(cwd))) throw new Error('无法确定 Markdown 文件的完整路径。');
  const resolved = path.resolve(cwd || path.dirname(filePath), filePath), stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error('朗读目标不是文件。');
  const { stdout } = await execute(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./open-markdown-in-edge-read-aloud.ps1', import.meta.url)), '-LiteralPath', resolved], { encoding: 'utf8', windowsHide: true });
  const result = JSON.parse(stdout);
  if (result.started !== true || result.foregroundConfirmed !== true) throw new Error('Microsoft Edge 未确认开始朗读。');
  return result;
}
