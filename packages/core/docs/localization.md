# Localization

Updated: 2026-11-19 01:58 (Asia/Taipei).

Core 0.3.39 adds shared locale selection for independently versioned Kits. English (`en`) is the primary language and Simplified Chinese (`zh-Hans`) is secondary. Each consumer owns its strings and language-specific artwork; Core owns selection, persistence and notifications.

## Selection and persistence

Core stores either `{ "mode": "auto" }` or `{ "mode": "fixed", "locale": "en" }` / `{ "mode": "fixed", "locale": "zh-Hans" }` in the Toolkit state's `language.json`. Automatic mode is separate from BCP 47 language values. An explicit selection overrides the environment.

In automatic mode, injected Kits read the host document's `lang` (or Core's reported host language), then the browser language, then the system's default locale. Local Toolkit management pages are desktop software settings: they use the host language reported over the existing Core binding, then the system language, regardless of the browser's language or Accept-Language header. The highest readable environment wins; an unsupported value selects English rather than a lower environment. English variants match `en`; Chinese using the Hans script matches `zh-Hans`. The native application's document language is never changed by a Kit.

Software language controls, including local Toolkit management pages, include Auto, English and 简体中文. Only separately published Web applications omit Auto; they are outside this desktop pilot.

## Renderer Kits

Declare `minimumCoreVersion: "0.3.39"` and require `context.i18n` when consuming this capability. The context provides:

- `i18n.locale`: current resolved language.
- `i18n.t(messages, key, values?)`: resolve a Kit-owned dictionary, falling back to its English entry. Use `{name}` placeholders with named values. Missing English keys or interpolation values are errors. Render plain strings through text/attribute APIs, not HTML.
- `i18n.onChange(callback)`: one locale callback per Kit; returns an unsubscribe function. It fires only when the resolved language changes. Close it with the Kit; the host also cleans it up on stop/startup failure.

Core observes the host document's language attribute, the renderer's browser-language event and shared preference changes through the existing host-state channel. A browser-language event affects renderer fallback only when the host language is unavailable; local management settings still ignore it. The existing renderer binding reports host-language changes to the desktop manager. It adds no polling and does not rebuild a Kit on a language change. Keep callbacks idempotent and limit them to the Kit's own text or assets.

A recreated native chat document reports its host language through the same binding. Core synchronizes the current preference even when that host language is unchanged; the registered bootstrap's earlier state cannot overwrite a saved selection indefinitely. This handoff updates the existing host rather than installing or rebuilding it again.

```js
const messages = { en: { clear: 'Clear cloud unread' }, 'zh-Hans': { clear: '清理云端未读' } };
const renderText = () => button.setAttribute('title', context.i18n.t(messages, 'clear'));
const unsubscribe = context.i18n.onChange(renderText);
renderText();
// Call unsubscribe() in close().
```

Keep user thread titles, native diagnostic details, numbers and actions unchanged. Localize a control's visible text, tooltip and accessible name together, retaining the control and its handlers. Shared rendering helpers may accept a Kit-owned formatter; a dependent Kit must require the first dependency version that supplies that contract. Language callbacks should update only text, without rerunning native queries, progress calculations or layout measurements.

## Management pages

Within the token-protected management root, `GET localization.mjs` exports the self-contained `createLocalization()` helper. It supplies `supported`, `validatePreference(value)`, `resolve(preference, environmentTags)` and `translate(messages, locale, key, values?)`.

`GET api/localization` returns `{preference, supported, locale, hostLanguage, systemLanguage}`. `POST api/localization` accepts the preference object and requires the existing `x-codex-toolkit-action: manage` header and same-origin checks. Invalid preferences return HTTP 400. A successful write persists the preference and emits the existing `api/events` status event with `languagePreference`, `hostLanguage` and `systemLanguage`; other open pages and injected Kits update from that event. Resolve against `[hostLanguage, systemLanguage]`, never navigator.language. Only management pages set their own document language.

Updated: 2026-11-19 15:19 (Asia/Taipei). Core 0.3.46 also supplies `hostAppearance` (`light`, `dark`, or `null` before the native window reports) through these responses and the existing status stream. The Kit host observes the native root's `data-theme` attribute alongside `lang`; it adds no polling. The management helper updates its document's `color-scheme` independently of locale changes. Pages use `color-scheme: light dark` and CSS `light-dark(lightColor, darkColor)`, following the system when no host value is available. Injected UI inherits the native document's color scheme directly and keeps the application's appearance setting unchanged.

Keep original native/plugin diagnostic text intact. A page translates its own controls and status prefixes. Updating language changes text/assets in place and does not reconnect native data or recreate controls.

From Core 0.3.41, desktop management pages can load `../../management-localization.js` before their classic inline script and call `window.createCodexTopKitsManagementI18n({messages, onChange, onError})`. The returned `t(key, values?)` is safe to pass unbound; `locale`, `ready` and `close()` expose the current language, initial synchronization and cleanup. Callbacks are asynchronous after creation. Static `data-i18n`, `data-i18n-title`, `data-i18n-placeholder` and `data-i18n-aria-label` bindings update their existing nodes. Dynamic labels use the page's cached state in `onChange`; do not fetch data or recreate inputs for a language change. The helper uses the protected Core localization endpoint and event stream, pauses that stream while hidden and closes it on page exit. A newer locale event takes precedence over an older initial response. Browser language is not a selection input.

Modules may supply `management.title` as `{en: 'Settings', 'zh-Hans': '设置'}`; existing string titles remain supported. The homepage updates these links in place. For normal health summaries, `context.setHealth()` accepts optional `messageLocales: {en: 'Ready', 'zh-Hans': '就绪'}` alongside its original `message`, `ok` and `issueCount`. Core chooses the summary at read time from the same preference; it does not rerun checks or replace raw diagnostic messages. A localized summary requires an English entry and only supported language keys.

Modules can also report `issues: [{key, message}]` using a stable source key and the original diagnostic message. The settings entry acknowledges those identities when opened and shows the current total count again when a new issue appears. Resolving an issue removes its acknowledgement; a recovery grace period retains it. Translated summaries do not change issue identity. Existing tooltip and diagnostic text remain unchanged.

## Launch and restart text

Core's PowerShell 7 helpers read the same language preference. An active native host supplies the resolved language to the restart request; before a host exists, launch messages use the persisted selection or system UI language. This does not add a browser preference or change official update, process-exit, cancellation or countdown behavior. Original subprocess errors and machine-readable receipts retain their original content. A missing PowerShell bootstrap still reports its prerequisite in English before the localization runtime is available.
