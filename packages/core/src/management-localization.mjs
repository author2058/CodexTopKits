// Serialized by the manager so every desktop settings page uses Core's selection rules.
export function createManagementI18n(createLocalization, { messages, onChange = () => {}, onError = error => { throw error; }, root = '../../' }, environment = globalThis) {
  const { document, window = environment, EventSource, AbortController } = environment;
  const localization = createLocalization(), abort = new AbortController();
  const bindings = [...document.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]')];
  let locale = 'en', initialized = false, closed = false, events, revision = 0;
  const t = (key, values) => localization.translate(messages, locale, key, values);
  const render = () => {
    if (document.documentElement.lang !== locale) document.documentElement.lang = locale;
    for (const node of bindings) {
      const key = node.getAttribute('data-i18n');
      if (key !== null) { const value = t(key); if (node.textContent !== value) node.textContent = value; }
      for (const name of ['title', 'placeholder', 'aria-label']) {
        const key = node.getAttribute('data-i18n-' + name);
        if (key !== null) { const value = t(key); if (node.getAttribute(name) !== value) node.setAttribute(name, value); }
      }
    }
    onChange(locale);
  };
  const apply = state => {
    if (closed) return;
    if (Object.hasOwn(state, 'hostAppearance')) {
      const scheme = state.hostAppearance ?? '';
      if (!['', 'light', 'dark'].includes(scheme)) throw new TypeError('Invalid host appearance.');
      if (document.documentElement.style.colorScheme !== scheme) document.documentElement.style.colorScheme = scheme;
    }
    const preference = state.preference ?? state.languagePreference;
    if (!preference) throw new TypeError('Language settings have no preference.');
    const next = localization.resolve(preference, [state.hostLanguage, state.systemLanguage]);
    if (initialized && next === locale) return;
    locale = next; initialized = true; render();
  };
  const connect = () => {
    events?.close(); events = null;
    if (closed || document.hidden) return;
    events = new EventSource(root + 'api/events');
    events.onmessage = event => {
      try { revision++; apply(JSON.parse(event.data)); } catch (error) { onError(error); }
    };
    events.onerror = () => { if (!closed) onError(new Error('Language settings connection interrupted.')); };
  };
  const close = () => {
    if (closed) return;
    closed = true; abort.abort(); events?.close(); events = null;
    document.removeEventListener('visibilitychange', connect); window.removeEventListener('pagehide', close);
  };
  const ready = Promise.resolve().then(async () => {
    if (closed) return;
    document.addEventListener('visibilitychange', connect); window.addEventListener('pagehide', close); connect();
    const initialRevision = revision;
    const response = await environment.fetch(root + 'api/localization', { cache: 'no-store', signal: abort.signal });
    const state = await response.json();
    if (!response.ok) throw Object.assign(new Error(state.error?.message || 'HTTP ' + response.status), { status: response.status });
    if (revision === initialRevision) apply(state);
  });
  ready.catch(error => { if (!(closed && error.name === 'AbortError')) onError(error); });
  return { t, get locale() { return locale; }, ready, close };
}
