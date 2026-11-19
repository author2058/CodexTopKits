import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializePage } from './cdp.mjs';
import { resolveFeatures, kitAssetPaths, matchesServiceVersion } from './features.mjs';
import { FeatureLoader } from './feature-loader.mjs';
import { unpackKitBundle } from './kit-bundle.mjs';
import { createGithubKitUpdates, compareKitVersions } from './github-kit-updates.mjs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import packageInfo from '../package.json' with { type: 'json' };

const binding = '__CODEXTOPKITS_FEATURE_ACTION__', globalName = '__CODEXTOPKITS_FEATURE_HOST__';
export async function readFeatureArtifact(directory, { coreVersion = packageInfo.version } = {}) {
  if (!path.isAbsolute(directory ?? '')) throw new Error('Feature artifact directory must be absolute.');
  let manifestFile = 'kit.json', contents;
  try { contents = await fs.readFile(path.join(directory, manifestFile)); }
  catch (error) {
    if (error.code !== 'ENOENT' || error.path !== path.join(directory, manifestFile)) throw error;
    // Older standalone artifacts used plugin.json. Do not hide errors in a present kit.json.
    manifestFile = 'plugin.json'; contents = await fs.readFile(path.join(directory, manifestFile));
  }
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents));
  if (manifest.minimumCoreVersion !== undefined) {
    const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
    const required = typeof manifest.minimumCoreVersion === 'string' && pattern.exec(manifest.minimumCoreVersion), current = pattern.exec(coreVersion);
    if (!required || !current) throw new Error('Invalid minimum Core version: ' + manifest.id);
    const wanted = required.slice(1).map(Number), actual = current.slice(1).map(Number);
    if (![...wanted, ...actual].every(Number.isSafeInteger)) throw new Error('Invalid minimum Core version: ' + manifest.id);
    const difference = actual[0] - wanted[0] || actual[1] - wanted[1] || actual[2] - wanted[2];
    if (difference < 0) throw new Error(manifest.id + ' requires Core ' + manifest.minimumCoreVersion + ' or later.');
  }
  const definition = { manifest, create() {} };
  resolveFeatures([{ ...definition, manifest: { ...manifest, dependencies: {} } }]);
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)
    || Object.values(manifest.dependencies).some(value => typeof value !== 'string')
    || manifest.services && (!Array.isArray(manifest.services) || manifest.services.some(value => !/^[a-z][a-z0-9-]*$/.test(value)))) throw new Error('Invalid feature artifact dependencies: ' + manifest.id);
  await fs.access(path.join(directory, manifest.entry));
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(path.join(directory, manifest.entry)));
  if (!source.startsWith('export default ')) throw new Error('Use a packed, self-contained feature artifact: ' + manifest.id);
  new Function(source.replace(/^export default /, 'return '));
  if (manifest.backendEntry !== undefined) {
    const version = manifest.minimumCoreVersion?.split('.').map(Number);
    if (manifest.backendEntry !== 'backend.mjs' || !version || version.length !== 3 || (version[0] === 0 && (version[1] < 3 || version[1] === 3 && version[2] < 20))) throw new Error('Kit backend requires Core 0.3.20 or later: ' + manifest.id);
    const backend = path.join(directory, manifest.backendEntry);
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(backend));
    await promisify(execFile)(process.execPath, ['--check', backend], { windowsHide: true, encoding: 'utf8' });
  }
  const assets = kitAssetPaths(manifest);
  if (assets.length) {
    const version = manifest.minimumCoreVersion?.split('.').map(Number);
    if (!version || version.length !== 3 || (version[0] === 0 && (version[1] < 3 || version[1] === 3 && version[2] < 21))) throw new Error('Kit assets require Core 0.3.21 or later: ' + manifest.id);
    await Promise.all(assets.map(name => fs.access(path.join(directory, name))));
  }
  if (manifest.serviceVersions !== undefined) {
    const version = manifest.minimumCoreVersion?.split('.').map(Number), requested = manifest.serviceVersions;
    if (!requested || typeof requested !== 'object' || Array.isArray(requested) || !Array.isArray(manifest.services)
      || Object.keys(requested).length !== manifest.services.length || Object.keys(requested).some(id => !manifest.services.includes(id))) throw new Error('Invalid Kit service versions: ' + manifest.id);
    if (!version || version.length !== 3 || (version[0] === 0 && (version[1] < 3 || version[1] === 3 && version[2] < 22))) throw new Error('Kit service versions require Core 0.3.22 or later: ' + manifest.id);
    for (const range of Object.values(requested)) matchesServiceVersion('0.0.0', range);
  }
  return { directory, manifest, manifestFile };
}

export { readFeatureArtifact as readKitArtifact };

export async function readKitArtifacts(directories, options) {
  const artifacts = await Promise.all(directories.map(directory => readFeatureArtifact(directory, options))), ids = new Set();
  for (const { manifest } of artifacts) {
    if (ids.has(manifest.id)) throw new Error('Duplicate installed feature ID: ' + manifest.id);
    ids.add(manifest.id);
  }
  return artifacts;
}

export default function featureRuntimePlugin({ cdpPort = 'auto', artifacts = [], enabled, services = {}, githubUpdates } = {}, dependencies = {}) {
  const github = githubUpdates ? createGithubKitUpdates(githubUpdates.repository, { request: dependencies.githubRequest }) : null;
  return { id: 'features', coreApiVersion: 1, cdpPort, async start(context) {
    const pages = new Map(), attaching = new Map(), issues = new Map(), listeners = new Set(), providers = new Map();
    const ownerId = randomUUID();
    const lifetime = new AbortController();
    let current = await readKitArtifacts(artifacts), selected = enabled || current.filter(value => value.manifest.defaultEnabled !== false).map(value => value.manifest.id), managed = new Set();
    const selectionPath = path.join(context.stateDirectory, 'selection.json');
    try {
      const saved = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(selectionPath)));
      if (!Array.isArray(saved.artifacts) || !Array.isArray(saved.enabled) || (saved.managed !== undefined && !Array.isArray(saved.managed))) throw new Error('Invalid saved feature selection.');
      const previous = await Promise.all(saved.artifacts.map(readFeatureArtifact));
      const configuredIds = new Set(current.map(value => value.manifest.id)), previousIds = new Set(previous.map(value => value.manifest.id));
      if (previousIds.size !== previous.length || (saved.managed || []).some(id => typeof id !== 'string' || !previousIds.has(id)) || new Set(saved.managed || []).size !== (saved.managed || []).length) throw new Error('Invalid saved feature selection.');
      managed = new Set((saved.managed || []).filter(id => !configuredIds.has(id)));
      current = current.map(value => previous.find(item => item.manifest.id === value.manifest.id) || value);
      current.push(...previous.filter(value => managed.has(value.manifest.id)));
      const installedIds = new Set(current.map(value => value.manifest.id));
      selected = [...saved.enabled.filter(id => installedIds.has(id)), ...selected.filter(id => !previousIds.has(id))];
    } catch (error) { if (error.code !== 'ENOENT' || error.path !== selectionPath) throw error; }
    const html = await fs.readFile(new URL('../assets/features.html', import.meta.url), 'utf8');
    let desired = [...selected], staged = new Map(), available = new Map(), githubToken = process.env.CODEXTOPKITS_GITHUB_TOKEN || '', loader, client, connecting, hostState, stopped = false, phase = 'starting', operation, lastSignature;
    const pageErrors = (features = [], targetId) => features.flatMap(feature => (feature.errors || (feature.error ? [feature.error] : []))
      .map(error => ({ ...error, featureId: feature.id, targetId })));
    const snapshot = () => {
      const pageRows = [...pages].map(([targetId, page]) => ({ targetId, features: page.features || [] }));
      const catalog = planned(), installedById = new Map(current.map(value => [value.manifest.id, value])), catalogIds = new Set(catalog.map(value => value.manifest.id));
      const errors = [...issues.values(), ...pageRows.flatMap(page => pageErrors(page.features, page.targetId))];
      return { phase, hostPid: loader?.child.pid ?? null, stablePid: process.pid, updateRepository: githubUpdates?.repository ?? null,
        features: catalog.map(value => {
          const installed = installedById.get(value.manifest.id);
          if (installed) value = installed;
          const update = available.get(value.manifest.id);
          return { ...value.manifest, installed: Boolean(installed), enabled: selected.includes(value.manifest.id), desired: desired.includes(value.manifest.id), prepared: staged.get(value.manifest.id)?.manifest || null,
            available: installed && update && compareKitVersions(update.version, value.manifest.version) > 0 ? { version: update.version } : null };
        }),
        availableKits: [...available.values()].filter(value => !catalogIds.has(value.id)).map(value => ({ id: value.id, version: value.version })),
        pages: pageRows, errors };
    };
    const publish = () => {
      const value = snapshot(), errors = value.errors;
      context.setHealth({ ok: errors.length === 0, issueCount: errors.length, message: errors.length ? errors.map(error => error.message).join('; ') : phase === 'waiting-for-app' ? 'Feature host is ready; waiting for Codex.' : 'Feature host is ready.',
        issues: errors.map(error => ({ key: JSON.stringify([error.targetId ?? null, error.featureId ?? null, error.key ?? error.source ?? null]), message: error.message })),
        ...(errors.some(error => error.featureId) ? { recoverable: false } : {}),
        ...(!errors.length ? { messageLocales: { en: phase === 'waiting-for-app' ? 'Feature host is ready; waiting for Codex.' : 'Feature host is ready.', 'zh-Hans': phase === 'waiting-for-app' ? 'Kit 宿主已就绪，等待 Codex。' : 'Kit 宿主已就绪。' } } : {}) });
      const signature = JSON.stringify(value); if (lastSignature !== signature) { lastSignature = signature; for (const listener of listeners) listener(value); }
    };
    const failed = (key, error) => { issues.set(key, { key, name: error.name, message: error.message, stack: error.stack, code: error.code }); publish(); };
    const recovered = key => { if (issues.delete(key)) publish(); };
    const stateFailed = (key, targetId, page, error) => {
      if (error.code === 'CDP_TARGET_CLOSED') return;
      if (pages.get(targetId) !== page && ['CDP_CONSUMER_CLOSED', 'CDP_DISCONNECTED'].includes(error.code)) return;
      failed(key, error);
    };
    const evaluate = async (page, expression) => {
      const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page.sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    const evaluatePage = (targetId, expression) => { const page = pages.get(targetId); if (!page) throw Object.assign(new Error('Feature page is unavailable: ' + targetId), { code: 'CDP_TARGET_CLOSED' }); return evaluate(page, expression); };
    const runtimeState = targetId => Object.assign({ targetId }, ...[...providers.values()].map(provider => provider.snapshot(targetId)));
    const deliverHostState = async (targetId, page) => {
      try {
        await evaluate(page, 'window.' + globalName + '?.setHostState(' + JSON.stringify(hostState) + ')');
        if (pages.get(targetId) === page) recovered('host-state:' + targetId);
      } catch (error) { stateFailed('host-state:' + targetId, targetId, page, error); }
    };
    const deliverState = async () => {
      await Promise.all([...pages].map(async ([targetId, page]) => {
        try { await evaluate(page, 'window.' + globalName + '?.setRuntimeState(' + JSON.stringify(runtimeState(targetId)) + ')'); if (pages.get(targetId) === page) recovered('state:' + targetId); }
        catch (error) { stateFailed('state:' + targetId, targetId, page, error); }
      }));
    };
    const planned = () => {
      const installedIds = new Set(current.map(value => value.manifest.id));
      return [...current.map(value => staged.get(value.manifest.id) || value), ...[...staged.values()].filter(value => !installedIds.has(value.manifest.id))];
    };
    const validate = (catalog, selection = desired) => {
      const missing = selection.filter(id => !catalog.some(value => value.manifest.id === id)); if (missing.length) throw new Error('Unknown selected features: ' + missing.join(', '));
      const definitions = catalog.filter(value => selection.includes(value.manifest.id)).map(value => ({ manifest: value.manifest, create() {} }));
      resolveFeatures(definitions);
      for (const value of definitions) for (const id of value.manifest.services || []) if (!services[id]) throw new Error(value.manifest.id + ' requires service ' + id);
      return definitions;
    };
    const validateServiceVersions = async definitions => {
      const loaded = new Map();
      for (const { manifest } of definitions) for (const [id, range] of Object.entries(manifest.serviceVersions || {})) {
        if (!loaded.has(id)) {
          const supplied = dependencies.serviceFactories?.[id];
          loaded.set(id, supplied ? { serviceApiVersion: supplied.serviceApiVersion } : await import(path.isAbsolute(services[id].module) ? pathToFileURL(services[id].module).href : services[id].module));
        }
        const module = loaded.get(id);
        if (typeof module.serviceApiVersion !== 'string' || !matchesServiceVersion(module.serviceApiVersion, range)) throw new Error(manifest.id + ' requires ' + id + ' service API ' + range + '; found ' + (module.serviceApiVersion ?? 'no version') + '.');
      }
    };
    const ensureServices = async (definitions, selection = desired, catalog = current, beforeCdp = false) => {
      const required = new Set(definitions.flatMap(value => value.manifest.services || []));
      const eligible = id => !beforeCdp || services[id]?.startBeforeCdp === true;
      for (const id of required) if (eligible(id) && !providers.has(id)) {
        const specification = services[id];
        const factory = dependencies.serviceFactories?.[id] || (await import(path.isAbsolute(specification.module) ? pathToFileURL(specification.module).href : specification.module)).default;
        const stateDirectory = path.join(context.stateDirectory, 'services', id); await fs.mkdir(stateDirectory, { recursive: true });
        providers.set(id, await factory({ ...specification.options, enabled: selection }, { cdp: client, cdpPort: context.cdp.port, evaluatePage, notify: deliverState, log: context.log, stateDirectory,
          reportError: (error, source = 'service') => error ? failed('service:' + id + ':' + source, error) : recovered('service:' + id + ':' + source), getPlugin: context.getPlugin }));
      }
      for (const [id, provider] of providers) {
        if (!eligible(id)) continue;
        if (required.has(id)) await provider.configure(selection, catalog);
        else { await provider.configure([]); await provider.close(); providers.delete(id); }
      }
    };
    const install = async (targetId, page) => {
      const source = await loader.request('build', { hostState, runtimeState: runtimeState(targetId), serviceVersionChecks: true, bindingName: binding, ownerId });
      const probes = [...providers.values()].map(provider => provider.pageSource?.(targetId) || '').join(';');
      const combined = '(async()=>{if(document.readyState==="loading")await new Promise(resolve=>document.addEventListener("DOMContentLoaded",resolve,{once:true}));' + probes + ';return ' + source + '})()';
      if (page.scriptId) await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: page.scriptId }, page.sessionId);
      page.scriptId = (await client.send('Page.addScriptToEvaluateOnNewDocument', { source: combined }, page.sessionId)).identifier;
      await evaluate(page, combined); recovered('page:' + targetId);
    };
    const attach = target => {
      if (stopped || !loader || target.type !== 'page' || !target.url.startsWith('app://') || pages.has(target.targetId)) return Promise.resolve();
      if (attaching.has(target.targetId)) return attaching.get(target.targetId);
      const work = (async () => { const page = await initializePage(client, target.targetId, binding); pages.set(target.targetId, page); await evaluate(page, cleanupExpression); await install(target.targetId, page); })()
        .catch(error => { if (error.code !== 'CDP_TARGET_CLOSED') { failed('page:' + target.targetId, error); throw error; } }).finally(() => attaching.delete(target.targetId));
      attaching.set(target.targetId, work); return work;
    };
    const remove = async targetId => { pages.delete(targetId); for (const key of issues.keys()) if (key.endsWith(':' + targetId)) issues.delete(key); for (const provider of providers.values()) await provider.removeTarget(targetId); publish(); };
    const receive = async message => {
      if (stopped) return;
      if (['Target.targetCreated', 'Target.targetInfoChanged'].includes(message.method)) return attach(message.params.targetInfo);
      if (message.method === 'Target.targetDestroyed') return remove(message.params.targetId);
      if (message.method === 'Target.detachedFromTarget') { const row = [...pages].find(([, page]) => page.sessionId === message.params.sessionId); if (row) await remove(row[0]); return; }
      const row = [...pages].find(([, page]) => page.sessionId === message.sessionId); if (!row) return;
      const [targetId, page] = row;
      if (message.method !== 'Runtime.bindingCalled' || message.params.name !== binding) return;
      const value = JSON.parse(message.params.payload);
      if (value.kind === 'feature-health') {
        if (!Array.isArray(value.features)) throw new TypeError('Invalid feature health report.');
        const previous = JSON.stringify(pageErrors(page.features, targetId));
        page.features = value.features;
        const errors = pageErrors(value.features, targetId); publish();
        if (previous !== JSON.stringify(errors)) await context.log({ event: 'kit-health-changed', targetId, executionContextId: message.params.executionContextId, issueCount: errors.length, errors });
        return;
      }
      if (value.kind === 'host-language') {
        // A new document reports even when the app language did not change.
        if (!context.setHostLanguage(value.language)) await deliverHostState(targetId, page);
        return;
      }
      if (value.kind === 'host-appearance') {
        if (!context.setHostAppearance(value.appearance)) await deliverHostState(targetId, page);
        return;
      }
      let handled = false;
      for (const provider of providers.values()) {
        try { if (await provider.receive(targetId, value)) { handled = true; recovered('action:' + value.kind + ':' + targetId); } }
        catch (error) { failed('action:' + value.kind + ':' + targetId, error); return; }
      }
      if (!handled) throw new Error('Unknown feature action: ' + value.kind);
    };
    const cleanupExpression = '(async()=>{const host=window.' + globalName + ';if(host){if(host.ownerId!==' + JSON.stringify(ownerId) + ')throw new Error("Another feature host owns this page.");await host.close();delete window.' + globalName + ';}return true})()';
    const preflightExpression = '(async()=>{const host=window.' + globalName + ';if(host){if(host.ownerId!==' + JSON.stringify(ownerId) + ')throw new Error("Another feature host owns this page.");await host.checkRestart();}return true})()';
    const preflightPages = async () => {
      await Promise.allSettled([...attaching.values()]);
      await Promise.all([...pages.values()].map(async page => {
        try { await evaluate(page, preflightExpression); } catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') throw error; }
      }));
    };
    const cleanupPages = async () => {
      await Promise.allSettled([...attaching.values()]);
      for (const [targetId, page] of pages) {
        try {
          if (page.scriptId) { await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: page.scriptId }, page.sessionId); page.scriptId = null; }
          await evaluate(page, cleanupExpression);
          page.features = []; recovered('cleanup:' + targetId);
        } catch (error) { if (error.code !== 'CDP_TARGET_CLOSED') { failed('cleanup:' + targetId, error); throw error; } }
      }
    };
    const persist = () => fs.writeFile(selectionPath, JSON.stringify({ artifacts: current.map(value => value.directory), enabled: selected, managed: [...managed] }) + '\n', 'utf8');
    const restart = () => {
      if (operation) return Promise.reject(new Error('A feature-host operation is already running.'));
      const work = (async () => {
        const catalog = planned(), definitions = validate(catalog);
        await validateServiceVersions(definitions);
        await preflightPages();
        phase = 'restarting'; publish();
        await cleanupPages(); await loader?.close();
        await ensureServices(definitions, desired, catalog, !client || client.closed);
        loader = new FeatureLoader({ onExit: error => failed('host', error) });
        const chosen = catalog.filter(value => desired.includes(value.manifest.id));
        const loaded = await loader.request('load', { directories: chosen.map(value => value.directory) });
        if (JSON.stringify(loaded) !== JSON.stringify(resolveFeatures(chosen.map(value => ({ manifest: value.manifest, create() {} }))).map(value => value.manifest))) throw new Error('Loaded feature manifests differ from their artifact manifests.');
        for (const [targetId, page] of pages) await install(targetId, page);
        if (client && !client.closed) await Promise.all(client.targets().map(attach));
        for (const value of catalog) if (!current.some(item => item.manifest.id === value.manifest.id)) managed.add(value.manifest.id);
        current = catalog; selected = [...desired]; staged.clear(); phase = client && !client.closed ? 'running' : 'waiting-for-app'; recovered('host'); recovered('selection'); await persist(); publish();
        await context.log({ event: 'feature-host-restarted', pid: loader.child.pid, features: definitions.map(value => ({ id: value.manifest.id, version: value.manifest.version })) });
        return snapshot();
      })().catch(error => { const changed = phase === 'restarting'; if (changed) phase = 'error'; failed(changed ? 'host' : 'selection', error); throw error; }).finally(() => { operation = null; }); operation = work; return work;
    };
    const unsubscribeState = context.onHostState(value => {
      hostState = value;
      for (const [targetId, page] of pages) void deliverHostState(targetId, page);
    });
    const connect = () => {
      if (connecting) return connecting;
      if (client && !client.closed && phase === 'running') return Promise.resolve();
      connecting = (async () => {
        await Promise.allSettled([operation, ...attaching.values()]);
        if (stopped) return;
        client?.handlers.delete(receive);
        if (client && !client.closed) { await cleanupPages(); await client.close(); }
        pages.clear();
        for (const key of issues.keys()) if (key.startsWith('state:') || key.startsWith('host-state:')) issues.delete(key);
        for (const [id, provider] of providers) if (services[id]?.startBeforeCdp !== true) { await provider.close(); providers.delete(id); }
        client = await context.cdp.acquire({ signal: lifetime.signal });
        client.onError = error => failed('cdp', error); client.handlers.add(receive);
        const definitions = validate(current, selected); await validateServiceVersions(definitions); await ensureServices(definitions, selected);
        await Promise.all(client.targets().map(attach)); phase = 'running'; recovered('cdp'); publish();
      })().catch(error => { if (!stopped) failed('cdp', error); throw error; }).finally(() => { connecting = null; });
      return connecting;
    };
    const unsubscribeReconnect = context.cdp.onReconnect(connect);
    try {
      validate(current); await restart();
    } catch (error) {
      unsubscribeState(); unsubscribeReconnect(); const failures = [];
      for (const cleanup of [() => client && !client.closed && cleanupPages(), () => loader?.close(), ...[...providers.values()].map(provider => () => provider.close()), () => { client?.handlers.delete(receive); return client?.close(); }]) {
        try { await cleanup(); } catch (failure) { failures.push(failure); }
      }
      if (failures.length) throw new AggregateError([error, ...failures], 'Feature startup and cleanup failed.', { cause: error });
      throw error;
    }
    void connect().catch(() => { /* connect preserves the original error in health. */ });
    const storeArtifact = async (candidate, installed) => {
        const { directory, manifest: { id } } = candidate;
        if (installed?.manifest.version === candidate.manifest.version) {
          const pairs = [[candidate.manifestFile, installed.manifestFile], ...[candidate.manifest.entry, candidate.manifest.backendEntry, ...kitAssetPaths(candidate.manifest)].filter(Boolean).map(name => [name, name])];
          for (const [source, previous] of pairs) if (!(await fs.readFile(path.join(directory, source))).equals(await fs.readFile(path.join(installed.directory, previous)))) throw new Error('A different artifact already uses this version.');
        }
        const output = path.join(context.stateDirectory, 'artifacts', id, candidate.manifest.version);
        await fs.mkdir(output, { recursive: true });
        const otherManifest = candidate.manifestFile === 'kit.json' ? 'plugin.json' : 'kit.json';
        try {
          const previous = await fs.readFile(path.join(output, otherManifest));
          if (!previous.equals(await fs.readFile(path.join(directory, candidate.manifestFile)))) throw new Error('A different artifact already uses this version.');
        } catch (error) { if (error.code !== 'ENOENT' || error.path !== path.join(output, otherManifest)) throw error; }
        for (const filename of [candidate.manifestFile, candidate.manifest.entry, candidate.manifest.backendEntry, ...kitAssetPaths(candidate.manifest)].filter(Boolean)) {
          const contents = await fs.readFile(path.join(directory, filename));
          await fs.mkdir(path.dirname(path.join(output, filename)), { recursive: true });
          try { await fs.writeFile(path.join(output, filename), contents, { flag: 'wx' }); }
          catch (error) { if (error.code !== 'EEXIST' || !contents.equals(await fs.readFile(path.join(output, filename)))) throw error; }
        }
        return readFeatureArtifact(output);
    };
    const downloadUpdate = async (id, update) => {
        const bytes = await github.download(update, githubToken, lifetime.signal), downloads = path.join(context.stateDirectory, 'downloads');
        lifetime.signal.throwIfAborted();
        await fs.mkdir(downloads, { recursive: true });
        const directory = await fs.mkdtemp(path.join(downloads, id + '-'));
        await unpackKitBundle(bytes, directory, update);
        lifetime.signal.throwIfAborted();
        return directory;
    };
    const instance = {
      snapshot, restart, connect,
      async check() {
        await connect();
        if (issues.has('cdp')) await client.send('Browser.getVersion');
        await Promise.all(client.targets().map(attach));
        await Promise.all([...pages].filter(([id]) => issues.has('page:' + id)).map(([id, page]) => install(id, page)));
        await deliverState();
        await Promise.all([...pages].map(async ([targetId, page]) => {
          await evaluate(page, 'window.' + globalName + '?.setHostState(' + JSON.stringify(hostState) + ')');
          recovered('host-state:' + targetId);
        }));
        if (!client.closed) recovered('cdp'); publish();
        return snapshot();
      },
      async prepare(id, directory) {
        if (operation) throw new Error('Wait for the current feature-host operation to finish.');
        const installed = current.find(value => value.manifest.id === id);
        if (!installed) throw new Error('Unknown installed feature: ' + id);
        const candidate = await readFeatureArtifact(directory); if (candidate.manifest.id !== id) throw new Error('Prepared artifact has a different feature ID.');
        const stored = await storeArtifact(candidate, installed);
        if (operation) throw new Error('Wait for the current feature-host operation to finish.');
        staged.set(id, stored); publish(); return snapshot();
      },
      async prepareInstall(directory) {
        if (operation) throw new Error('Wait for the current feature-host operation to finish.');
        const candidate = await readFeatureArtifact(directory), id = candidate.manifest.id;
        if (current.some(value => value.manifest.id === id)) throw new Error('Kit is already installed or prepared: ' + id);
        const prepared = staged.get(id);
        if (prepared) {
          if (prepared.manifest.version !== candidate.manifest.version) throw new Error('Kit is already prepared at a different version: ' + id);
          await storeArtifact(candidate, prepared); return snapshot();
        }
        if (current.some(value => value.manifest.id === id) || staged.has(id)) throw new Error('Kit is already installed or prepared: ' + id);
        const stored = await storeArtifact(candidate);
        if (operation) throw new Error('Wait for the current feature-host operation to finish.');
        if (current.some(value => value.manifest.id === id) || staged.has(id)) throw new Error('Kit is already installed or prepared: ' + id);
        staged.set(id, stored); if (candidate.manifest.defaultEnabled !== false) desired = [...desired, id]; publish(); return snapshot();
      },
      async checkUpdates(token) {
        if (!github) throw new Error('No GitHub update repository is configured.');
        if (token !== undefined && typeof token !== 'string') throw new TypeError('Invalid GitHub token.');
        const credential = token || githubToken;
        const updates = await github.list(credential, undefined, lifetime.signal);
        lifetime.signal.throwIfAborted();
        githubToken = credential; available = new Map(updates.map(value => [value.id, value])); publish(); return snapshot();
      },
      async prepareUpdate(id) {
        if (!github) throw new Error('No GitHub update repository is configured.');
        if (operation) throw new Error('Wait for the current feature-host operation to finish.');
        const installed = current.find(value => value.manifest.id === id), update = available.get(id);
        if (!installed || !update || compareKitVersions(update.version, installed.manifest.version) <= 0) throw new Error('No newer update is available for this Kit.');
        return instance.prepare(id, await downloadUpdate(id, update));
      },
      async prepareAvailableInstall(id) {
        if (!github) throw new Error('No GitHub update repository is configured.');
        if (operation) throw new Error('Wait for the current feature-host operation to finish.');
        const update = available.get(id);
        if (!update || current.some(value => value.manifest.id === id) || staged.has(id)) throw new Error('No installable Kit is available: ' + id);
        return instance.prepareInstall(await downloadUpdate(id, update));
      },
      select(id, value) {
        if (operation) throw new Error('Wait for the current feature-host operation to finish.');
        if (!planned().some(item => item.manifest.id === id) || typeof value !== 'boolean') throw new Error('Invalid feature selection.');
        desired = value ? [...new Set([...desired, id])] : desired.filter(item => item !== id); publish(); return snapshot();
      },
      management: { title: 'Kits', request: async ({ method, url, body }) => {
        if (method === 'GET' && url.pathname === '/') return { type: 'text/html; charset=utf-8', body: html };
        if (method === 'GET' && url.pathname === '/api/state') return { body: snapshot() };
        if (method === 'GET' && url.pathname === '/api/events') return { subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); } };
        if (method === 'POST' && url.pathname === '/api/restart') return { body: await restart() };
        if (method === 'POST' && url.pathname === '/api/prepare') return { body: await instance.prepare(body.id, body.directory) };
        if (method === 'POST' && url.pathname === '/api/prepare-install') return { body: await instance.prepareInstall(body.directory) };
        if (method === 'POST' && url.pathname === '/api/check-updates') return { body: await instance.checkUpdates(body.token) };
        if (method === 'POST' && url.pathname === '/api/prepare-update') return { body: await instance.prepareUpdate(body.id) };
        if (method === 'POST' && url.pathname === '/api/prepare-available-install') return { body: await instance.prepareAvailableInstall(body.id) };
        if (method === 'POST' && url.pathname === '/api/select') return { body: instance.select(body.id, body.enabled) };
        return null;
      } },
      async close() {
        stopped = true; githubToken = ''; lifetime.abort(new Error('Feature runtime stopped.')); unsubscribeState(); unsubscribeReconnect(); await Promise.allSettled([operation, connecting]);
        const failures = [];
        for (const cleanup of [() => client && !client.closed ? cleanupPages() : pages.clear(), () => loader?.close(), ...[...providers.values()].map(provider => () => provider.close()), () => { client?.handlers.delete(receive); return client?.close(); }]) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        listeners.clear();
        if (failures.length) throw new AggregateError(failures, 'Feature runtime cleanup failed.', { cause: failures[0] });
      },
    };
    return instance;
  } };
}
