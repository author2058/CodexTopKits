// Prepare one temporary qualitative observation; never rewrite the source PNG.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSharp } from './load-sharp.mjs';
import { imageEncodingPlan } from './codex-image-policy.mjs';
import { inspectImage } from './image-delivery-audit.mjs';

export function observationPlan(width, height, profile) {
  if (profile) return imageEncodingPlan({ width, height, target: 'model', profile });
  const high = imageEncodingPlan({ width, height, target: 'model', profile: 'high' });
  const original = imageEncodingPlan({ width, height, target: 'model', profile: 'original' });
  if (high.format !== original.format) throw new Error('Encoding depends on the effective model budget; specify the verified --profile high or original.');
  return { ...high, profile: null, profileIndependent: true,
    nativeSize: JSON.stringify(high.nativeSize) === JSON.stringify(original.nativeSize) ? high.nativeSize : null };
}

const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function provenanceXmp(metadata) {
  const fields = Object.entries(metadata).map(([key, value]) => `ha:${key}="${xmlEscape(value)}"`).join(' ');
  return Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:ha="urn:codex-desktop-toolkit:image-observation:1" ${fields}/></rdf:RDF></x:xmpmeta>`, 'utf8');
}

export async function prepareModelImage({ source, project, profile, sharpEntry }) {
  if (!source || !project) throw new Error('Specify the source PNG and the thread project directory.');
  const sourcePath = await fs.realpath(source), projectPath = await fs.realpath(project);
  if (!(await fs.stat(projectPath)).isDirectory()) throw new Error('The thread project must be a directory.');
  const file = await fs.open(sourcePath, 'r');
  let data, before, after;
  try { before = await file.stat(); data = await file.readFile(); after = await file.stat(); }
  finally { await file.close(); }
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('The source changed while being read.');
  const original = inspectImage(data);
  if (original.format !== 'png') throw new Error('This entry prepares existing PNGs; read existing efficient formats directly.');
  if (data[24] > 8) throw new Error('Only 8-bit PNG observations are supported; use the original for higher precision.');
  const plan = observationPlan(original.width, original.height, profile);
  const sharp = await loadSharp(sharpEntry); sharp.cache(false);
  const fallback = plan.format === 'webp' && !sharp.format.webp.output.buffer ? 'webp-encoder-unavailable' : null;
  const format = fallback ? 'jpeg' : plan.format, quality = format === 'webp' ? 85 : 90;
  const image = sharp(data);
  if (format === 'jpeg') {
    const sourceInfo = await image.metadata();
    // Only JPEG inputs with an alpha channel need an extra source-pixel scan.
    if (sourceInfo.hasAlpha && !(await image.stats()).isOpaque)
      throw new Error('JPEG cannot preserve this PNG transparency; use the lossless original when transparency matters.');
  }
  const id = randomUUID(), createdAt = new Date().toISOString();
  const metadata = { version: 1, id, purpose: 'qualitative-model-observation', sourcePath,
    sourceCreatedAt: before.birthtime.toISOString(), sourceModifiedAt: before.mtime.toISOString(), createdAt,
    width: original.width, height: original.height, format, quality, policyId: plan.policyId };
  image.withXmp(provenanceXmp(metadata).toString('utf8'));
  const { data: output, info } = await image[format]({ quality }).toBuffer({ resolveWithObject: true });
  // Validate the encoder result and container headers without decoding the output again.
  const actual = inspectImage(output);
  if (info.format !== format || actual.format !== format || actual.width !== original.width ||
      actual.height !== original.height || actual.compression !== 'lossy')
    throw new Error('The encoder output does not match the format/dimension contract.');
  const temp = path.join(projectPath, 'Temp'); await fs.mkdir(temp, { recursive: true });
  const physicalTemp = await fs.realpath(temp);
  const relative = path.relative(projectPath, physicalTemp);
  if ((process.platform === 'win32' ? relative.toLowerCase() !== 'temp' : relative !== 'Temp'))
    throw new Error('The project Temp directory resolves outside the project.');
  const destination = path.join(physicalTemp, `${id}${format === 'webp' ? '.webp' : '.jpg'}`);
  const target = await fs.open(destination, 'wx');
  try { await target.writeFile(output); }
  catch (error) {
    const failures = [error];
    try { await target.close(); } catch (cleanup) { failures.push(cleanup); }
    try { await fs.unlink(destination); } catch (cleanup) { failures.push(cleanup); }
    throw failures.length === 1 ? error : new AggregateError(failures, 'Image write and cleanup failed.');
  }
  await target.close();
  return { path: destination, ...metadata, bytes: output.length, profile: plan.profile,
    profileIndependent: plan.profileIndependent === true, fallback };
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('node prepare-model-image.mjs --project PROJECT [--profile high|original] SOURCE.png\nWrites one UUID.webp/JPG90 in PROJECT/Temp with embedded XMP provenance; prints UTF-8 JSON. Never changes the source or resizes.\nWithout --profile, proceeds only if both supported model budgets select the same encoding. Encoder: the locally locked Sharp/libvips dependency.');
    return;
  }
  const options = {}; const flags = { '--project': 'project', '--profile': 'profile', '--sharp-entry': 'sharpEntry' };
  for (let index = 0; index < args.length; ++index) {
    if (flags[args[index]]) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${args[index]}`);
      options[flags[args[index]]] = args[++index];
    } else if (!args[index].startsWith('--') && !options.source) options.source = args[index];
    else throw new Error(`Unknown or repeated argument: ${args[index]}`);
  }
  console.log(JSON.stringify(await prepareModelImage(options)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
