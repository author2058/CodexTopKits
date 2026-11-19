// Self-contained so management pages and serialized Kit hosts use the same rules.
export function createLocalization() {
  const supported = Object.freeze(['en', 'zh-Hans']);
  const validatePreference = (value = { mode: 'auto' }) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || (value.mode !== 'auto' && value.mode !== 'fixed')
      || Object.keys(value).some(key => !['mode', 'locale'].includes(key))
      || value.mode === 'auto' && Object.hasOwn(value, 'locale')
      || value.mode === 'fixed' && !supported.includes(value.locale)) throw new TypeError('Invalid language preference.');
    return value.mode === 'auto' ? { mode: 'auto' } : { mode: 'fixed', locale: value.locale };
  };
  const resolve = (preference, environment = []) => {
    const value = validatePreference(preference);
    if (value.mode === 'fixed') return value.locale;
    const tag = environment.find(value => typeof value === 'string' && value.trim());
    if (!tag) return 'en';
    let locale;
    try { locale = new Intl.Locale(tag.trim()); }
    catch (error) { if (error instanceof RangeError) return 'en'; throw error; }
    if (locale.language === 'en') return 'en';
    if (locale.language === 'zh' && locale.maximize().script === 'Hans') return 'zh-Hans';
    return 'en';
  };
  const translate = (messages, locale, key, values = {}) => {
    if (!Object.hasOwn(messages?.en ?? {}, key) || typeof messages.en[key] !== 'string') throw new Error('Missing English translation: ' + key);
    const text = messages[locale]?.[key] ?? messages.en[key];
    if (typeof text !== 'string') throw new TypeError('Invalid translation: ' + key);
    return text.replace(/\{(\w+)\}/g, (_match, name) => {
      if (!Object.hasOwn(values, name)) throw new TypeError('Missing translation value: ' + name);
      return String(values[name]);
    });
  };
  return Object.freeze({ supported, validatePreference, resolve, translate });
}
