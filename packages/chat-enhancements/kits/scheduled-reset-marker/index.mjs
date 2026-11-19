import manifest from './kit.json' with { type: 'json' };
import { hardResetRange } from '../../src/hard-reset.mjs';

export function createScheduledReset({ document, dependencies, getRuntimeState, onRuntimeState, i18n }, { hardResetRange }) {
  if (typeof i18n?.t !== 'function' || typeof i18n?.onChange !== 'function') throw new Error('scheduled-reset-marker requires Core 0.3.39 or later.');
  const messages = {
    en: { forecast: 'Estimated hard reset: {date} · Data from Codex Resets', error: ' · Query failed; keeping the last estimate: {error}', source: ' · Click to view source' },
    'zh-Hans': { forecast: '预计硬重置：{date} · 数据来自 Codex Resets', error: ' · 查询异常，保留上次预计时间：{error}', source: ' · 点击查看来源' },
  };
  const style = document.createElement('style'); style.setAttribute('data-cdtk-owned', 'scheduled-reset-marker');
  style.textContent = '#codex-usage-toolbar .codex-usage-hard-reset{position:absolute;top:0;right:0;height:2px;z-index:1;background:#ef4444;pointer-events:auto}';
  const title = value => i18n.t(messages, 'forecast', { date: new Date(value.forecast.scheduledAt).toLocaleString(i18n.locale === 'zh-Hans' ? 'zh-CN' : 'en-US', { hour12: false }) })
    + (value.error ? i18n.t(messages, 'error', { error: value.error.message }) : i18n.t(messages, 'source'));
  const refresh = () => dependencies['weekly-usage'].setHardReset(getRuntimeState()?.hardReset || null, hardResetRange, title);
  let unsubscribe, unsubscribeLocale;
  try { unsubscribeLocale = i18n.onChange(dependencies['weekly-usage'].renderHardResetTitle); unsubscribe = onRuntimeState(refresh); document.head.appendChild(style); refresh(); }
  catch (error) { unsubscribe?.(); unsubscribeLocale?.(); style.remove(); throw error; }
  return { close() { unsubscribe(); unsubscribeLocale(); dependencies['weekly-usage'].setHardReset(null, null); style.remove(); } };
}
export default { manifest, create: createScheduledReset, helpers: { hardResetRange } };
