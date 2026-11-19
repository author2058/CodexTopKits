import manifest from './kit.json' with { type: 'json' };
import { installUsageToolbar } from '../../src/toolbar.mjs';
import { weeklyProgress } from '../../src/weekly-progress.mjs';
import { weeklyUsageCss } from '../../src/styles.mjs';
import { findNativeUsageClient, nativeUsageSnapshot } from '../../src/native-client.mjs';
import { isNativeRateLimitQuery, findNativeRateLimitQuery } from '../../src/native-usage.mjs';

export function createWeeklyUsage(context, helpers) {
  const { document, dependencies, getHostState, onDomChange, reportError, i18n } = context;
  if (typeof i18n?.t !== 'function' || typeof i18n?.onChange !== 'function') throw new Error('weekly-usage requires Core 0.3.39 or later.');
  const { installUsageToolbar, weeklyProgress, weeklyUsageCss, findNativeUsageClient, nativeUsageSnapshot, findNativeRateLimitQuery, isNativeRateLimitQuery } = helpers;
  let client, unsubscribeQuery, stopped = false, present = false, forecastRange;
  const style = document.createElement('style'); style.setAttribute('data-cdtk-owned', 'weekly-usage'); style.textContent = weeklyUsageCss();
  const toolbar = installUsageToolbar(document, getHostState, weeklyProgress,
    (_document, owner, state) => dependencies.footer.acquire(owner, state), (...values) => forecastRange?.(...values) || null, 'weekly-usage', i18n);
  const update = () => {
    if (stopped || !client) return;
    const snapshot = nativeUsageSnapshot(client, findNativeRateLimitQuery);
    if (snapshot) toolbar.update(snapshot);
    reportError(null, 'native-usage');
  };
  const refresh = () => {
    const mounted = !!document.querySelector('main.main-surface,main[class*="MainContentSurface"]');
    if (mounted && !client) {
      client = findNativeUsageClient(document, findNativeRateLimitQuery);
      if (client) {
        unsubscribeQuery = client.getQueryCache().subscribe(event => {
          if (isNativeRateLimitQuery(event?.query)) { try { update(); } catch (error) { reportError(error, 'native-usage'); } }
        });
        update();
      }
    }
    if (mounted !== present) { present = mounted; toolbar.refresh(); }
  };
  let unsubscribeDom, unsubscribeLocale;
  try { unsubscribeLocale = i18n.onChange(toolbar.renderLabel); unsubscribeDom = onDomChange(refresh); document.head.appendChild(style); refresh(); }
  catch (error) { stopped = true; unsubscribeDom?.(); unsubscribeLocale?.(); unsubscribeQuery?.(); toolbar.cleanup(); style.remove(); throw error; }
  return { setHardReset(value, range, title) { forecastRange = range; toolbar.setHardReset(value, title); }, renderHardResetTitle: toolbar.renderHardResetTitle,
    close() { stopped = true; unsubscribeDom(); unsubscribeLocale(); unsubscribeQuery?.(); toolbar.cleanup(); style.remove(); } };
}

export default { manifest, create: createWeeklyUsage, helpers: { installUsageToolbar, weeklyProgress, weeklyUsageCss,
  findNativeUsageClient, nativeUsageSnapshot, isNativeRateLimitQuery, findNativeRateLimitQuery } };
