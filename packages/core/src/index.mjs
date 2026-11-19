import fs from 'node:fs/promises';
import path from 'node:path';
import { createCdpService } from './cdp.mjs';
import { RecoveryHealth } from './recovery.mjs';
import { randomUUID } from 'node:crypto';
import { createLocalization } from './localization.mjs';

export const CORE_API_VERSION = 1;

// One host owns its installed plugins; importing this package starts nothing.
export async function createPluginHost({ stateDirectory, plugins = [] }) {
  if (!path.isAbsolute(stateDirectory ?? '')) throw new Error('Pass an absolute, dedicated toolkit state directory.');
  const localization = createLocalization(), languagePath = path.join(stateDirectory, 'language.json');
  let languagePreference = { mode: 'auto' };
  try { languagePreference = localization.validatePreference(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(languagePath)))); }
  catch (error) { if (error.code !== 'ENOENT' || error.path !== languagePath) throw error; }
  const ids = new Set();
  for (const plugin of plugins) {
    if (typeof plugin.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(plugin.id)) throw new Error('Invalid plugin ID.');
    if (ids.has(plugin.id)) throw new Error('Duplicate plugin: ' + plugin.id);
    if (plugin.coreApiVersion !== CORE_API_VERSION) throw new Error('Incompatible core API: ' + plugin.id);
    if (typeof plugin.start !== 'function') throw new Error('Missing plugin start: ' + plugin.id);
    ids.add(plugin.id);
  }

  const requestedPorts = plugins.map(plugin => plugin.cdpPort).filter(value => value !== undefined);
  const cdp = requestedPorts.length ? await createCdpService(requestedPorts, { onDiagnostic: entry => {
    void log(entry).catch(error => console.error('CDP diagnostic write failed:', error));
  } }) : null;
  await fs.mkdir(stateDirectory, { recursive: true });
  const logPath = path.join(stateDirectory, 'events.jsonl');
  const instances = new Map(), checks = new Map(), recoveries = new Map(), stateListeners = new Set();
  const startedAt = new Date().toISOString();
  let writes = Promise.resolve(), languageWrites = Promise.resolve(), closing, managerUrl = null, stateSignature = null, hostLanguage = null, hostAppearance = null;
  const systemLanguage = Intl.DateTimeFormat().resolvedOptions().locale;
  const health = () => {
    const locale = localization.resolve(languagePreference, [hostLanguage, systemLanguage]);
    return { ok: !closing && [...checks.values()].every(check => check.ok), startedAt,
      plugins: [...checks].map(([id, { messageLocales, ...check }]) => ({ id, ...check,
        message: messageLocales?.[locale] ?? messageLocales?.en ?? (check.recovering && locale === 'zh-Hans' ? '正在重新连接…' : check.message) })) };
  };
  const hostState = () => ({ managerUrl, health: health(), languagePreference: { ...languagePreference }, hostLanguage, systemLanguage, hostAppearance });
  const onHostState = listener => { stateListeners.add(listener); listener(hostState()); return () => stateListeners.delete(listener); };
  const publishState = () => {
    const value = hostState(), signature = JSON.stringify(value);
    if (signature === stateSignature) return;
    stateSignature = signature;
    for (const listener of stateListeners) listener(value);
  };
  const setHostLanguage = value => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('Invalid host language.');
    if (value === hostLanguage) return false;
    hostLanguage = value; publishState(); return true;
  };
  const setHostAppearance = value => {
    if (!['light', 'dark'].includes(value)) throw new TypeError('Invalid host appearance.');
    if (value === hostAppearance) return false;
    hostAppearance = value; publishState(); return true;
  };
  const log = entry => {
    const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n';
    writes = writes.then(() => fs.appendFile(logPath, line, 'utf8'));
    return writes;
  };
  const close = ({ applicationExited = false } = {}) => {
    if (!closing) closing = (async () => {
      const errors = [];
      await languageWrites;
      stateListeners.clear();
      if (applicationExited) {
        try { cdp?.applicationExited(); } catch (error) { errors.push(error); }
      }
      const recoveryWork = Promise.allSettled([...recoveries.values()].map(recovery => recovery.close()));
      for (const [id, instance] of [...instances].reverse()) {
        try { await instance.close(); checks.set(id, { ok: false, message: 'Stopped.', messageLocales: { en: 'Stopped.', 'zh-Hans': '已停止。' } }); }
        catch (error) { errors.push(error); }
      }
      try { await cdp?.close(); } catch (error) { errors.push(error); }
      await recoveryWork;
      try { await writes; } catch (error) { errors.push(error); }
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Plugin shutdown failed.');
    })();
    return closing;
  };

  try {
    for (const plugin of plugins) {
      const directory = path.join(stateDirectory, 'plugins', plugin.id);
      await fs.mkdir(directory, { recursive: true });
      checks.set(plugin.id, { ok: false, message: 'Starting.', messageLocales: { en: 'Starting.', 'zh-Hans': '正在启动。' } });
      const recovery = new RecoveryHealth(() => {
        const next = recovery.health();
        if (JSON.stringify(checks.get(plugin.id)) !== JSON.stringify(next)) { checks.set(plugin.id, next); publishState(); }
      }, error => { void log({ event: 'recovery-failed', plugin: plugin.id, name: error.name, message: error.message, code: error.code, stack: error.stack })
        .catch(failure => console.error('Recovery diagnostic write failed:', failure)); });
      recoveries.set(plugin.id, recovery);
      let reported = false;
      const instance = await plugin.start(Object.freeze({
        apiVersion: CORE_API_VERSION,
        cdp: plugin.cdpPort !== undefined ? cdp.forOwner(plugin.id) : null,
        stateDirectory: directory,
        getPlugin: id => instances.get(id),
        log: entry => log({ ...entry, plugin: plugin.id }),
        onHostState,
        setHostLanguage,
        setHostAppearance,
        setHealth(check) {
          if (typeof check?.ok !== 'boolean' || typeof check.message !== 'string') throw new Error('Invalid plugin health: ' + plugin.id);
          if (check.messageLocales !== undefined && (!check.messageLocales || Array.isArray(check.messageLocales) || typeof check.messageLocales.en !== 'string'
            || Object.entries(check.messageLocales).some(([key, value]) => !localization.supported.includes(key) || typeof value !== 'string'))) throw new TypeError('Invalid localized plugin health: ' + plugin.id);
          if (check.issueCount !== undefined && (!Number.isSafeInteger(check.issueCount) || check.issueCount < 0 || check.ok && check.issueCount !== 0)) throw new Error('Invalid plugin issue count: ' + plugin.id);
          if (check.issues !== undefined && (!Array.isArray(check.issues) || check.issues.some(issue => !issue || typeof issue.key !== 'string' || typeof issue.message !== 'string') || check.ok && check.issues.length)) throw new TypeError('Invalid plugin issues: ' + plugin.id);
          if (check.recoverable !== undefined && typeof check.recoverable !== 'boolean') throw new TypeError('Invalid plugin recoverability: ' + plugin.id);
          const next = { ok: check.ok, message: check.message, issueCount: check.issueCount ?? check.issues?.length ?? (check.ok ? 0 : 1),
            ...(check.issues ? { issues: check.issues.map(({ key, message }) => ({ key, message })) } : {}),
            ...(check.recoverable !== undefined ? { recoverable: check.recoverable } : {}),
            ...(check.messageLocales ? { messageLocales: { ...check.messageLocales } } : {}) };
          recovery.update(next);
          reported = true;
        },
      }));
      if (typeof instance?.close !== 'function') throw new Error('Missing plugin close: ' + plugin.id);
      instances.set(plugin.id, instance);
      const retry = instance.recover ?? instance.check;
      if (typeof retry === 'function') recovery.start(async () => { await cdp?.ensureConnected(); await retry.call(instance); });
      if (!reported) checks.set(plugin.id, { ok: true, message: 'Started.', messageLocales: { en: 'Started.', 'zh-Hans': '已启动。' } });
      publishState();
    }
  } catch (error) {
    try { await close(); }
    catch (cleanup) {
      if (cleanup !== error) throw new AggregateError([error, cleanup], 'Plugin startup and cleanup failed.', { cause: error });
    }
    throw error;
  }

  return Object.freeze({
    apiVersion: CORE_API_VERSION,
    stateDirectory,
    launchEnvironment: cdp ? { CODEX_TOOLKIT_CDP_PORT: String(cdp.port) } : {},
    cdpStatus: () => cdp?.status() ?? null,
    async reconnect() {
      if (closing) throw new Error('The plugin host is stopping.');
      await cdp?.reconnect();
    },
    getPlugin: id => instances.get(id),
    health,
    onState: onHostState,
    languagePreference: () => ({ ...languagePreference }),
    languageEnvironment: () => ({ hostLanguage, systemLanguage }),
    setHostLanguage,
    appearance: () => hostAppearance,
    setHostAppearance,
    setLanguagePreference(value) {
      const preference = localization.validatePreference(value);
      if (closing) return Promise.reject(new Error('The plugin host is stopping.'));
      const work = languageWrites.then(async () => {
        if (JSON.stringify(preference) === JSON.stringify(languagePreference)) return { ...languagePreference };
        const temporary = languagePath + '.' + randomUUID() + '.tmp';
        await fs.writeFile(temporary, JSON.stringify(preference) + '\n', { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, languagePath);
        languagePreference = preference; publishState();
        return { ...languagePreference };
      });
      // Return the original failure; the queue only orders later explicit requests.
      languageWrites = work.then(() => {}, () => {});
      return work;
    },
    setManagementUrl(value) { managerUrl = value; publishState(); },
    async check() {
      if (closing) throw new Error('The plugin host is stopping.');
      for (const [id, instance] of instances) {
        if (typeof instance.check !== 'function') continue;
        await recoveries.get(id).run(() => instance.check(), true);
      }
      return health();
    },
    close,
  });
}
