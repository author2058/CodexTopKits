#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { selectEfforts } from '../packages/session-recovery/src/model-effort-calculator.mjs';
import { defaults, readJson, loadInputs } from '../packages/session-recovery/src/model-effort-source.mjs';

export { selectEfforts, defaults, readJson };
const requireValue = (condition, message) => { if (!condition) throw new TypeError(message); };

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { usage: { type: 'string', default: defaults.usage }, iq: { type: 'string', default: defaults.iq }, 'timeout-ms': { type: 'string', default: '60000' }, help: { type: 'boolean', default: false } } });
  if (values.help) return 'Usage: node tools/select-model-effort.mjs [--usage FILE_OR_URL] [--iq FILE_OR_URL] [--timeout-ms 60000]\nPrints JSON recommendations for Sol, Terra, Astra and Luna. Inputs: UTF-8 JSON (one leading BOM accepted). No Codex settings are changed.\n';
  const timeout = Number(values['timeout-ms']); requireValue(Number.isSafeInteger(timeout) && timeout > 0, 'timeout-ms must be a positive integer.');
  const { usage, iq } = await loadInputs({ usage: values.usage, iq: values.iq, timeoutMs: timeout });
  return JSON.stringify({ ...selectEfforts(usage, iq), inputLocations: { usage: values.usage, iq: values.iq } }, null, 2) + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(await main(), 'utf8'); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
