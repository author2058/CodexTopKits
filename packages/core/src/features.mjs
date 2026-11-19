import { createLocalization } from './localization.mjs';

export function resolveFeatures(definitions) {
  // shortcut: exact and caret releases only; use full semver when other ranges are needed.
  const matchesVersion = (actual, requested) => {
    const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
    const range = typeof requested === 'string' && requested.startsWith('^');
    const wanted = typeof requested === 'string' && pattern.exec(range ? requested.slice(1) : requested);
    const current = pattern.exec(actual);
    if (!wanted || !current) throw new TypeError('Invalid feature dependency version: ' + requested);
    const minimum = wanted.slice(1).map(Number), version = current.slice(1).map(Number);
    if (![...minimum, ...version].every(Number.isSafeInteger)) throw new TypeError('Invalid feature dependency version: ' + requested);
    if (!range) return actual === requested;
    const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const upper = minimum[0] ? [minimum[0] + 1, 0, 0] : minimum[1] ? [0, minimum[1] + 1, 0] : [0, 0, minimum[2] + 1];
    return compare(version, minimum) >= 0 && compare(version, upper) < 0;
  };
  const registry = new Map(), order = [], visiting = new Set(), visited = new Set();
  for (const definition of definitions) {
    const { manifest, create, helpers = {} } = definition;
    if (!manifest || !/^[a-z][a-z0-9-]*$/.test(manifest.id) || !/^\d+\.\d+\.\d+$/.test(manifest.version)
      || manifest.coreApiVersion !== 1 || manifest.entry !== 'index.mjs' || typeof create !== 'function' || !manifest.dependencies
      || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)
      || manifest.defaultEnabled !== undefined && typeof manifest.defaultEnabled !== 'boolean'
      || Object.values(helpers).some(value => typeof value !== 'function')) throw new TypeError('Invalid feature definition.');
    if (registry.has(manifest.id)) throw new Error('Duplicate feature: ' + manifest.id);
    registry.set(manifest.id, definition);
  }
  const visit = id => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('Feature dependency cycle: ' + id);
    visiting.add(id);
    for (const [dependency, version] of Object.entries(registry.get(id).manifest.dependencies)) {
      const found = registry.get(dependency);
      if (!found) throw new Error('Missing feature dependency: ' + id + ' requires ' + dependency);
      if (!matchesVersion(found.manifest.version, version)) throw new Error('Incompatible feature dependency: ' + id + ' requires ' + dependency + '@' + version);
      visit(dependency);
    }
    visiting.delete(id); visited.add(id); order.push(registry.get(id));
  };
  for (const id of registry.keys()) visit(id);
  return order;
}

export function createFeatureHost(definitions, { document, hostState = null, runtimeState = null, serviceVersionChecks = false, dispatch = () => { throw new Error('Feature action service is unavailable.'); }, onChange = () => {}, onHostLanguage = null, onHostAppearance = null } = {}) {
  const ordered = resolveFeatures(definitions), registry = new Map(ordered.map(value => [value.manifest.id, value]));
  const active = new Map(), starting = new Map(), errors = new Map(), subscriptions = new Map(), stateSubscriptions = new Map(), localeSubscriptions = new Map();
  const localization = createLocalization(), window = document?.defaultView;
  const readLocale = () => localization.resolve(hostState?.languagePreference, [document?.documentElement?.getAttribute?.('lang') || hostState?.hostLanguage, window?.navigator?.language, hostState?.systemLanguage || Intl.DateTimeFormat().resolvedOptions().locale]);
  let lastLocale = readLocale(), localeObserver, reportedHostLanguage, reportedHostAppearance;
  let observer, scheduled = false, closed = false, signature;
  const snapshot = () => ordered.map(({ manifest }) => {
    const issues = [...errors.values()].filter(value => value.featureId === manifest.id);
    return { ...manifest, state: active.has(manifest.id) ? 'running' : 'stopped', error: issues[0] || null, errors: issues };
  });
  const publish = () => { const value = snapshot(), next = JSON.stringify(value); if (next !== signature) { signature = next; onChange(value); } };
  const failed = (id, error, source) => {
    const key = id + ':' + source;
    if (error) {
      const value = { featureId: id, source, name: error.name, message: error.message, stack: error.stack, code: error.code };
      if (JSON.stringify(errors.get(key)) === JSON.stringify(value)) return;
      errors.set(key, value);
    } else if (!errors.delete(key)) return;
    publish();
  };
  const clear = id => { for (const [key, value] of errors) if (value.featureId === id) errors.delete(key); };
  const disconnect = () => { if (!subscriptions.size) { observer?.disconnect(); observer = null; } };
  const disconnectLocale = () => {
    if (localeSubscriptions.size) return;
    window?.removeEventListener?.('languagechange', refreshLocale);
    if (onHostLanguage || onHostAppearance) return;
    localeObserver?.disconnect(); localeObserver = null;
  };
  const reportHostLanguage = () => {
    if (!onHostLanguage || !document?.documentElement || !document.querySelector('main.main-surface,main[class*="MainContentSurface"]')) return;
    const language = document.documentElement.getAttribute('lang');
    if (language && language !== reportedHostLanguage) { reportedHostLanguage = language; onHostLanguage(language); }
  };
  const reportHostAppearance = () => {
    if (!onHostAppearance || !document?.documentElement || !document.querySelector('main.main-surface,main[class*="MainContentSurface"]')) return;
    const appearance = document.documentElement.getAttribute('data-theme');
    if (['light', 'dark'].includes(appearance) && appearance !== reportedHostAppearance) { reportedHostAppearance = appearance; onHostAppearance(appearance); }
  };
  const refreshLocale = () => {
    reportHostLanguage(); reportHostAppearance();
    const locale = readLocale(); if (locale === lastLocale) return;
    lastLocale = locale;
    for (const [id, listener] of localeSubscriptions) {
      try { listener(locale); failed(id, null, 'locale'); } catch (error) { failed(id, error, 'locale'); }
    }
  };
  const observeLocale = () => {
    if (!localeObserver && document?.documentElement && window?.MutationObserver) {
      localeObserver = new window.MutationObserver(records => { if (records.some(record => ['lang', 'data-theme'].includes(record.attributeName))) refreshLocale(); });
      localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'data-theme'] });
    }
  };
  const subscribeLocale = (id, listener) => {
    localeSubscriptions.set(id, listener);
    if (localeSubscriptions.size === 1) { lastLocale = readLocale(); observeLocale(); window?.addEventListener?.('languagechange', refreshLocale); }
    return () => { localeSubscriptions.delete(id); disconnectLocale(); };
  };
  const unsubscribe = id => { subscriptions.delete(id); stateSubscriptions.delete(id); localeSubscriptions.delete(id); disconnect(); disconnectLocale(); };
  const subscribe = (id, listener) => {
    subscriptions.set(id, listener);
    if (!observer) {
      observer = new document.defaultView.MutationObserver(records => {
        const owned = node => node?.nodeType === 1 && (node.hasAttribute('data-cdtk-owned') || node.closest('[data-cdtk-owned]'));
        if (records.every(record => owned(record.target) || [...record.addedNodes, ...record.removedNodes].length
          && [...record.addedNodes, ...record.removedNodes].every(owned))) return;
        if (!scheduled) { scheduled = true; document.defaultView.queueMicrotask(() => { scheduled = false; refresh(); }); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    return () => { subscriptions.delete(id); disconnect(); };
  };
  const refresh = () => {
    if (closed) return;
    if (!reportedHostLanguage) reportHostLanguage();
    if (!reportedHostAppearance) reportHostAppearance();
    for (const [id, listener] of subscriptions) {
      try { listener(); failed(id, null, 'dom'); }
      catch (error) { failed(id, error, 'dom'); }
    }
  };
  const start = id => {
    if (closed) return Promise.reject(new Error('The feature host is closed.'));
    const definition = registry.get(id);
    if (!definition) return Promise.reject(new Error('Unknown feature: ' + id));
    if (active.has(id)) return Promise.resolve(active.get(id));
    if (starting.has(id)) return starting.get(id);
    const work = (async () => {
      for (const dependency of Object.keys(definition.manifest.dependencies)) await start(dependency);
      try {
        if (definition.manifest.serviceVersions && serviceVersionChecks !== true) throw new Error('Kit requires verified service versions (Core 0.3.23 or later).');
        const dependencies = Object.fromEntries(Object.keys(definition.manifest.dependencies).map(key => [key, active.get(key)]));
        const api = await definition.create({ document, dependencies, restartPreflight: true, sharedCdpPort: true, serviceVersionChecks, getHostState: () => hostState, getRuntimeState: () => runtimeState,
          onRuntimeState(listener) { stateSubscriptions.set(id, listener); return () => stateSubscriptions.delete(id); },
          i18n: { get locale() { return readLocale(); }, supported: localization.supported,
            t: (messages, key, values) => localization.translate(messages, readLocale(), key, values),
            onChange: listener => subscribeLocale(id, listener) },
          dispatch: action => dispatch(action, id), onDomChange: listener => subscribe(id, listener),
          reportError: (error, source = 'plugin') => failed(id, error, source) }, definition.helpers || {});
        if (typeof api?.close !== 'function') throw new TypeError('Feature has no close method: ' + id);
        active.set(id, api); failed(id, null, 'startup'); publish(); return api;
      } catch (error) { unsubscribe(id); failed(id, error, 'startup'); throw error; }
    })().finally(() => starting.delete(id));
    starting.set(id, work); return work;
  };
  const stop = async id => {
    if (starting.has(id)) await starting.get(id);
    const dependents = [...new Set([...active.keys(), ...starting.keys()])].filter(key => Object.hasOwn(registry.get(key).manifest.dependencies, id));
    if (dependents.length) throw new Error('Feature is in use: ' + id + ' required by ' + dependents.join(', '));
    const api = active.get(id); if (!api) return;
    try { await api.close(); active.delete(id); unsubscribe(id); clear(id); publish(); }
    catch (error) { failed(id, error, 'cleanup'); throw error; }
  };
  if (onHostLanguage || onHostAppearance) { reportHostLanguage(); reportHostAppearance(); observeLocale(); }
  return { start, stop, snapshot, refresh, setHostState(value) { hostState = value; refreshLocale(); refresh(); },
    async checkRestart() { for (const api of active.values()) await api.beforeRestart?.(); },
    setRuntimeState(value) {
      runtimeState = value;
      for (const [id, listener] of stateSubscriptions) {
        try { listener(value); failed(id, null, 'state'); } catch (error) { failed(id, error, 'state'); }
      }
    },
    async close() {
      // Startup failures are already reported; they must not prevent active dependencies from closing.
      await Promise.allSettled([...starting.values()]);
      for (const { manifest } of [...ordered].reverse()) await stop(manifest.id);
      closed = true; observer?.disconnect(); observer = null; localeObserver?.disconnect(); localeObserver = null; window?.removeEventListener?.('languagechange', refreshLocale);
    },
  };
}

export function featurePayload(definitions, { hostState = null, runtimeState = null, serviceVersionChecks = false, bindingName = null, ownerId = null } = {}) {
  resolveFeatures(definitions);
  const sources = definitions.map(featureSource);
  return '(async()=>{if(window.__CODEXTOPKITS_FEATURE_HOST__)throw new Error("A feature host already owns this page.");'
    + 'if(document.readyState==="loading")await new Promise(resolve=>document.addEventListener("DOMContentLoaded",resolve,{once:true}));'
    + 'const createLocalization=(' + createLocalization.toString() + ');const resolveFeatures=(' + resolveFeatures.toString() + ');const host=(' + createFeatureHost.toString() + ')([' + sources.join(',')
    + '],{document,hostState:' + JSON.stringify(hostState) + ',runtimeState:' + JSON.stringify(runtimeState) + ',serviceVersionChecks:' + JSON.stringify(serviceVersionChecks)
    + (bindingName ? ',dispatch:action=>{const send=window[' + JSON.stringify(bindingName) + '];if(typeof send!=="function")throw new Error("Feature action service is unavailable.");send(JSON.stringify(action));},onChange:features=>window[' + JSON.stringify(bindingName) + '](JSON.stringify({kind:"feature-health",features})),onHostLanguage:language=>window[' + JSON.stringify(bindingName) + '](JSON.stringify({kind:"host-language",language})),onHostAppearance:appearance=>window[' + JSON.stringify(bindingName) + '](JSON.stringify({kind:"host-appearance",appearance}))' : '')
    + '});host.ownerId=' + JSON.stringify(ownerId) + ';window.__CODEXTOPKITS_FEATURE_HOST__=host;'
    + 'try{for(const item of host.snapshot())await host.start(item.id);return host.snapshot();}'
    + 'catch(error){try{await host.close();delete window.__CODEXTOPKITS_FEATURE_HOST__;}catch(cleanup){throw new AggregateError([error,cleanup],"Feature startup and cleanup failed.",{cause:error});}throw error;}})()';
}

function featureSource({ manifest, create, helpers = {} }) {
  // Function.toString preserves checkout line endings; artifacts must not depend on Git's platform setting.
  const sourceOf = fn => fn.toString().replace(/\r\n?/g, '\n');
  const declarations = Object.entries(helpers).map(([name, fn]) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new TypeError('Invalid feature helper name: ' + name);
    return 'const ' + name + '=(' + sourceOf(fn) + ');';
  }).join('');
  const createSource = manifest.serviceVersions ? 'function(context,helpers){if(context?.serviceVersionChecks!==true)throw new Error("Kit requires verified service versions (Core 0.3.23 or later).");return (' + sourceOf(create) + ')(context,helpers);}' : sourceOf(create);
  const source = '(()=>{' + declarations + 'return {manifest:' + JSON.stringify(manifest) + ',create:(' + createSource
    + '),helpers:{' + Object.keys(helpers).join(',') + '}}})()';
  new Function('return ' + source);
  return source;
}

export function featureModule(definition) {
  // Dependencies are validated together by the host, not bundled into each update artifact.
  if (!definition.manifest?.dependencies || typeof definition.manifest.dependencies !== 'object' || Array.isArray(definition.manifest.dependencies)) throw new TypeError('Invalid feature dependencies.');
  if (definition.manifest.serviceVersions) {
    const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(definition.manifest.minimumCoreVersion || '');
    const numbers = version?.slice(1).map(Number);
    if (!numbers || !numbers.every(Number.isSafeInteger) || numbers[0] === 0 && (numbers[1] < 3 || numbers[1] === 3 && numbers[2] < 23)) throw new Error('Packing Kit service versions requires Core 0.3.23 or later.');
  }
  resolveFeatures([{ ...definition, manifest: { ...definition.manifest, dependencies: {} } }]);
  return 'export default ' + featureSource(definition) + ';\n';
}

export function kitAssetPaths(manifest) {
  const assets = manifest.assets ?? [];
  if (!Array.isArray(assets)) throw new TypeError('Invalid Kit assets.');
  const seen = new Set(['kit.json', 'plugin.json', 'index.mjs', 'backend.mjs']);
  for (const name of assets) {
    if (typeof name !== 'string' || !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || seen.has(name.toLowerCase())) throw new TypeError('Invalid or duplicate Kit asset: ' + name);
    seen.add(name.toLowerCase());
  }
  return assets;
}

export function matchesServiceVersion(actual, requested) {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const caret = typeof requested === 'string' && requested.startsWith('^');
  const wanted = typeof requested === 'string' && pattern.exec(caret ? requested.slice(1) : requested), found = typeof actual === 'string' && pattern.exec(actual);
  if (!wanted || !found) throw new TypeError('Invalid service dependency version.');
  const minimum = wanted.slice(1).map(Number), version = found.slice(1).map(Number);
  if (![...minimum, ...version].every(Number.isSafeInteger)) throw new TypeError('Invalid service dependency version.');
  if (!caret) return actual === requested;
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const upper = minimum[0] ? [minimum[0] + 1, 0, 0] : minimum[1] ? [0, minimum[1] + 1, 0] : [0, 0, minimum[2] + 1];
  return compare(version, minimum) >= 0 && compare(version, upper) < 0;
}

// Keep the original feature API as aliases while the Kit terminology is adopted.
export { resolveFeatures as resolveKits, createFeatureHost as createKitHost, featurePayload as kitPayload, featureModule as kitModule };
