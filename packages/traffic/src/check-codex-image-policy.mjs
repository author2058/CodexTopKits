import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { captureNativeImageRequest } from './native-image-probe.mjs';
import { createImagePolicyFixtures } from './native-image-fixtures.mjs';
import { IMAGE_POLICY_ID, IMAGE_POLICY_SOURCE, nativeImageDimensions } from './codex-image-policy.mjs';

const run = promisify(execFile);
const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
export const CHECKER_REVISION = 2;

export function evaluateDefaultProfile(matchedProfiles, previous) {
  const baseline = previous?.identity?.policyId === IMAGE_POLICY_ID && previous?.identity?.checkerRevision === CHECKER_REVISION
    && Array.isArray(previous.defaultProfileBaseline) && previous.defaultProfileBaseline.length ? previous.defaultProfileBaseline : null;
  const changed = Boolean(matchedProfiles.length && baseline && JSON.stringify(matchedProfiles) !== JSON.stringify(baseline));
  return { defaultProfileBaseline: baseline ?? (matchedProfiles.length ? matchedProfiles : null), defaultProfileChanged: changed,
    failure: !matchedProfiles.length || changed ? 'The compiled default image budget or codec behavior changed; review the default profile.' : null };
}

export function compareImagePolicy(probe, profile) {
  const failures = [];
  const sent = probe.requests.at(-1)?.images || [];
  if (sent.length !== probe.sources.length) return ['Image count changed.'];
  for (const [index, source] of probe.sources.entries()) {
    const size = nativeImageDimensions(source.width, source.height, profile);
    const resized = size[0] !== source.width || size[1] !== source.height;
    const format = source.format;
    const compression = format === 'png' || (format === 'webp' && resized) ? 'lossless' : 'lossy';
    const image = sent[index];
    if (image.width !== size[0] || image.height !== size[1] || image.format !== format || image.compression !== compression
        || (!resized && !image.byteIdenticalSources.includes(source.path))) {
      failures.push(`${path.basename(source.path)}: expected ${size.join('x')} ${format}/${compression}${resized ? '' : ' original bytes'}; observed ${image.width}x${image.height} ${image.format}/${image.compression}`);
    }
  }
  return failures;
}

export async function discoverDesktopCodex(powershellPath = 'pwsh', { signal } = {}) {
  const command = String.raw`$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
$runtimes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'codex.exe'" | Where-Object { $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)' } | ForEach-Object {
    $client = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($_.ParentProcessId)"
    if ($client.Name -eq 'ChatGPT.exe') { [pscustomobject]@{ executable = $_.ExecutablePath; clientIdentity = $client.ExecutablePath } }
} | Sort-Object -Property executable,clientIdentity -Unique)
if ($runtimes.Count -ne 1 -or -not $runtimes[0].executable -or -not $runtimes[0].clientIdentity) { throw "Expected one running Desktop Codex app-server; found $($runtimes.Count)." }
$runtimes[0] | ConvertTo-Json -Compress`;
  const result = await run(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'buffer', windowsHide: true, signal });
  const runtime = decode(result.stdout);
  if (!path.isAbsolute(runtime.executable) || path.basename(runtime.executable).toLowerCase() !== 'codex.exe'
      || !path.isAbsolute(runtime.clientIdentity)) throw new Error('Native image probe: invalid Desktop runtime identity.');
  return runtime;
}

async function writeReport(filename, report) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, filename);
}

export async function checkCodexImagePolicy({ executable, clientIdentity = null, stateDirectory, force = false, signal, sharpEntry }) {
  if (!path.isAbsolute(stateDirectory ?? '')) throw new Error('Pass an absolute, dedicated native-policy state directory.');
  signal?.throwIfAborted();
  const stat = await fs.stat(executable);
  const identity = { executable, bytes: stat.size, mtimeMs: stat.mtimeMs, clientIdentity, policyId: IMAGE_POLICY_ID, checkerRevision: CHECKER_REVISION };
  const reportFile = path.join(stateDirectory, 'native-policy-check.json');
  let previous;
  try { previous = decode(await fs.readFile(reportFile)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!force && !previous?.error && typeof previous?.ok === 'boolean' && JSON.stringify(previous.identity) === JSON.stringify(identity)) {
    return { ...previous, cached: true };
  }
  await fs.mkdir(stateDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  let version;
  const probes = {}, failures = [];
  let defaultProfile = evaluateDefaultProfile([], previous);
  try {
    const result = await run(executable, ['--version'], { encoding: 'buffer', windowsHide: true, signal });
    version = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout).trim();
    const directory = path.join(stateDirectory, 'native-policy-probes', randomUUID());
    const filenames = await createImagePolicyFixtures(path.join(directory, 'fixtures'), { signal, sharpEntry });
    for (const [profile, unifiedImageBudget] of [['high', false], ['original', true], ['default', undefined]]) {
      signal?.throwIfAborted();
      const outputDirectory = path.join(directory, profile);
      const probe = await captureNativeImageRequest({ executable, outputDirectory, filenames, unifiedImageBudget, signal });
      const matchedProfiles = ['high', 'original'].filter(candidate => compareImagePolicy(probe, candidate).length === 0);
      probes[profile] = { report: path.join(outputDirectory, 'native-request-report.json'), matchedProfiles, imageCount: probe.sources.length,
        nativeVersionHeader: probe.requests.at(-1)?.nativeVersion ?? null };
      if (profile === 'default') {
        defaultProfile = evaluateDefaultProfile(matchedProfiles, previous);
        if (defaultProfile.failure) failures.push(defaultProfile.failure);
      } else failures.push(...compareImagePolicy(probe, profile).map(message => profile + ': ' + message));
    }
  } catch (error) {
    const report = { identity, version, policyId: IMAGE_POLICY_ID, source: IMAGE_POLICY_SOURCE, startedAt, checkedAt: new Date().toISOString(), ok: false,
      failures: [...failures, error.message], error: { name: error.name, message: error.message, code: error.code, stack: error.stack }, probes,
      defaultProfileBaseline: defaultProfile.defaultProfileBaseline, defaultProfileChanged: defaultProfile.defaultProfileChanged };
    try { await writeReport(reportFile, report); }
    catch (writeError) { throw new AggregateError([error, writeError], 'Native policy check and diagnostic write failed.', { cause: error }); }
    throw error;
  }
  const report = { identity, version, policyId: IMAGE_POLICY_ID, source: IMAGE_POLICY_SOURCE, startedAt, checkedAt: new Date().toISOString(),
    ok: failures.length === 0, failures, probes, defaultProfileBaseline: defaultProfile.defaultProfileBaseline,
    defaultProfileChanged: defaultProfile.defaultProfileChanged, modelCalls: 0, loopbackOnly: true };
  await writeReport(reportFile, report);
  return { ...report, cached: false };
}
