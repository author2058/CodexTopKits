import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function optional(filename) {
  try { return await fs.readFile(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, filename);
}
async function unchangedAuditCommand(previous, nodeExecutable, logFile, auditScript) {
  const hook = previous?.group?.hooks?.length === 1 ? previous.group.hooks[0] : null;
  const command = hook?.command, prefix = `& ${quote(nodeExecutable)} `, suffix = ` hook ${quote(logFile)}`;
  if (typeof command !== 'string' || hook.commandWindows !== command || !command.startsWith(prefix) || !command.endsWith(suffix)) return null;
  const argument = command.slice(prefix.length, -suffix.length);
  if (!/^'(?:[^']|'')+'$/.test(argument)) return null;
  const oldScript = argument.slice(1, -1).replaceAll("''", "'");
  if (!path.isAbsolute(oldScript) || path.basename(oldScript) !== 'image-delivery-audit.mjs') return null;
  const [oldBytes, newBytes] = await Promise.all([optional(oldScript), fs.readFile(auditScript)]);
  if (!oldBytes || !oldBytes.equals(newBytes) || /\b(?:import\s*\(|require\s*\(|from\s*['"](?!node:)|import\s*['"](?!node:))/.test(decode(newBytes))) return null;
  return command;
}
function locations(codexHome, stateDirectory) {
  if (![codexHome, stateDirectory].every(value => path.isAbsolute(value ?? ''))) throw new Error('Specify absolute Codex home and bandwidth state directories.');
  return { codexHome: path.resolve(codexHome), stateDirectory: path.resolve(stateDirectory),
    hooksFile: path.join(codexHome, 'hooks.json'), skillFile: path.join(codexHome, 'skills', 'codex-bandwidth-images', 'SKILL.md'),
    receiptFile: path.join(stateDirectory, 'image-integration.json') };
}

export async function imageIntegrationStatus({ codexHome, stateDirectory }) {
  const files = locations(codexHome, stateDirectory), bytes = await optional(files.receiptFile);
  if (!bytes) return { installed: false, ...files, trust: 'not-checked' };
  const receipt = JSON.parse(decode(bytes));
  if (receipt.codexHome !== files.codexHome) throw new Error('Image integration receipt belongs to another Codex home.');
  const hooks = await optional(files.hooksFile), skill = await optional(files.skillFile);
  const present = hooks && (JSON.parse(decode(hooks)).hooks?.PreToolUse ?? []).some(group => same(group, receipt.group));
  return { installed: Boolean(present && skill && hash(skill) === receipt.skillHash), ...files, trust: 'not-checked', installedAt: receipt.installedAt };
}

export async function installImageIntegration({ codexHome, stateDirectory, nodeExecutable = process.execPath, assetRoot = root, sharpEntry = createRequire(import.meta.url).resolve('sharp') }) {
  const files = locations(codexHome, stateDirectory);
  if (!path.isAbsolute(nodeExecutable)) throw new Error('Specify the absolute standalone Node executable.');
  if (![assetRoot, sharpEntry].every(value => path.isAbsolute(value ?? ''))) throw new Error('Specify absolute image Kit and Sharp paths.');
  const previousBytes = await optional(files.receiptFile), previous = previousBytes && JSON.parse(decode(previousBytes));
  if (previous && previous.codexHome !== files.codexHome) throw new Error('Image integration receipt belongs to another Codex home.');
  const original = await optional(files.hooksFile), config = original ? JSON.parse(decode(original)) : { hooks: {} };
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('Invalid hooks.json hooks object.');
  const groups = config.hooks.PreToolUse ?? [];
  if (!Array.isArray(groups)) throw new Error('Invalid PreToolUse hook groups.');
  const kept = groups.filter(group => !previous || !same(group, previous.group));
  if (kept.some(group => group.hooks?.some(hook => /image-delivery-audit\.mjs["']?\s+["']?hook/.test(hook.commandWindows ?? hook.command ?? '')))) {
    throw new Error('An image audit Hook from another installation already exists. Keep or remove that installation explicitly before installing these rules.');
  }
  const logFile = previous?.logFile ?? path.join(stateDirectory, 'image-delivery', 'events.jsonl');
  if (!path.isAbsolute(logFile)) throw new Error('Specify an absolute image audit log path.');
  const auditScript = path.join(assetRoot, 'src', 'image-delivery-audit.mjs');
  const command = await unchangedAuditCommand(previous, nodeExecutable, logFile, auditScript)
    ?? `& ${quote(nodeExecutable)} ${quote(auditScript)} hook ${quote(logFile)}`;
  const group = { matcher: '^view_image$', hooks: [{ type: 'command', command, commandWindows: command, statusMessage: '检查图片格式' }] };
  const template = await fs.readFile(path.join(assetRoot, 'assets', 'image-skill.md'), 'utf8');
  const skill = template.replaceAll('{{NODE}}', quote(nodeExecutable)).replaceAll('{{SHARP}}', quote(sharpEntry)).replaceAll('{{ROOT}}', assetRoot.replaceAll('\\', '/').replace(/\/$/, '').replaceAll("'", "''"));
  const existingSkill = await optional(files.skillFile);
  if (existingSkill && (!previous || ![previous.skillHash, hash(skill)].includes(hash(existingSkill)))) throw new Error('The image skill is not owned by this installation or has local edits; it was not overwritten.');
  if (previous && same(previous.group, group) && groups.some(value => same(value, group)) && existingSkill && hash(existingSkill) === hash(skill)) return imageIntegrationStatus(files);
  const current = await optional(files.hooksFile);
  if (!same(original?.toString('base64'), current?.toString('base64'))) throw new Error('hooks.json changed during installation; no changes were written.');
  await fs.mkdir(stateDirectory, { recursive: true });
  if (original) await fs.writeFile(path.join(stateDirectory, 'hooks-before-' + randomUUID() + '.json'), original);
  config.hooks.PreToolUse = [...kept, group];
  await writeJson(files.hooksFile, config);
  await fs.mkdir(path.dirname(files.skillFile), { recursive: true });
  await fs.writeFile(files.skillFile, skill, 'utf8');
  await writeJson(files.receiptFile, { codexHome: files.codexHome, group, skillHash: hash(skill), logFile, installedAt: new Date().toISOString() });
  return imageIntegrationStatus(files);
}

export async function removeImageIntegration({ codexHome, stateDirectory }) {
  const files = locations(codexHome, stateDirectory), bytes = await optional(files.receiptFile);
  if (!bytes) return { removed: false, reason: 'No installation receipt; nothing was changed.' };
  const receipt = JSON.parse(decode(bytes));
  if (receipt.codexHome !== files.codexHome) throw new Error('Image integration receipt belongs to another Codex home.');
  const skill = await optional(files.skillFile);
  if (skill && hash(skill) !== receipt.skillHash) throw new Error('The installed image skill has local edits; nothing was removed.');
  const original = await optional(files.hooksFile);
  if (original) {
    const config = JSON.parse(decode(original)), groups = config.hooks?.PreToolUse;
    if (!Array.isArray(groups)) throw new Error('Invalid PreToolUse hook groups; nothing was removed.');
    const kept = groups.filter(group => !same(group, receipt.group));
    if (kept.length === groups.length && groups.some(group => group.hooks?.some(hook => hook.command === receipt.group.hooks[0].command))) throw new Error('The installed image Hook has local edits; nothing was removed.');
    if (kept.length !== groups.length) {
      await fs.writeFile(path.join(stateDirectory, 'hooks-before-' + randomUUID() + '.json'), original);
      config.hooks.PreToolUse = kept;
      await writeJson(files.hooksFile, config);
    }
  }
  if (skill) await fs.unlink(files.skillFile);
  await fs.unlink(files.receiptFile);
  return { removed: true, retained: 'Logs, backups, Codex trust state and unrelated configuration were not removed.' };
}
