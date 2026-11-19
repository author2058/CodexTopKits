export function installUsageToolbar(document, getHostState, weeklyProgress, acquireFooter, hardResetRange = () => null, owner = 'chat', i18n = null) {
  const view = document.defaultView;
  let usage = null, hardReset = null, hardResetTitle = null, toolbar = null, footer = null, label, summary, minuteTimer = null, stopped = false;
  const messages = { en: { pending: 'Waiting for native usage…' }, 'zh-Hans': { pending: '等待原生用量…' } };
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const style = (element, key, value) => { if (element.style.getPropertyValue(key) !== value) element.style.setProperty(key, value); };
  const renderLabel = () => {
    if (!label || !toolbar) return;
    const weekly = usage?.weekly;
    if (!weekly) { text(label, i18n ? i18n.t(messages, 'pending') : '等待原生用量…'); return; }
    const date = new Date(weekly.resetAt), day = i18n?.locale === 'en' ? (date.getMonth() + 1) + '/' + date.getDate() : (date.getMonth() + 1) + '月' + date.getDate() + '日';
    text(label, weekly.remainingPercent + '% · ' + day + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0'));
  };
  const renderHardResetTitle = () => {
    const resetLine = summary?.querySelector('.codex-usage-hard-reset');
    if (!resetLine || !hardReset?.forecast) return;
    const title = hardResetTitle ? hardResetTitle(hardReset) : '预计硬重置：' + new Date(hardReset.forecast.scheduledAt).toLocaleString('zh-CN', { hour12: false }) + ' · Data from Codex Resets' + (hardReset.error ? ' · 查询异常，保留上次预计时间：' + hardReset.error.message : ' · 点击查看来源');
    if (resetLine.title !== title) resetLine.title = title;
  };
  const progress = () => {
    if (!toolbar) return;
    const value = weeklyProgress(usage?.weekly);
    for (const kind of ['usage', 'time']) {
      let bar = summary.querySelector('[data-kind="' + kind + '"]');
      if (!bar) {
        bar = document.createElement('span'); bar.className = 'codex-usage-progress'; bar.dataset.kind = kind; bar.setAttribute('aria-hidden', 'true');
        const ticks = document.createElement('span'); ticks.className = 'codex-usage-progress-ticks'; bar.appendChild(ticks); summary.appendChild(bar);
      }
      if (bar.hidden !== !value) bar.hidden = !value;
      if (!value) continue;
      style(bar, '--cdt-weekly-progress-width', (kind === 'usage' ? value.usagePercent : value.timePercent) + '%');
      style(bar, '--cdtk-weekly-days', String(value.days));
      if (kind === 'time') {
        const range = hardResetRange(usage?.weekly, hardReset?.forecast, value);
        let resetLine = bar.querySelector('.codex-usage-hard-reset');
        if (range) {
          if (!resetLine) { resetLine = document.createElement('a'); resetLine.className = 'codex-usage-hard-reset'; resetLine.href = 'https://codex-resets.com'; resetLine.target = '_blank'; resetLine.rel = 'noopener noreferrer'; bar.appendChild(resetLine); }
          style(resetLine, 'left', range.leftPercent + '%');
          renderHardResetTitle();
        } else resetLine?.remove();
        let morning = bar.querySelector('.codex-usage-progress-morning');
        if (!morning) { morning = document.createElement('span'); morning.className = 'codex-usage-progress-morning'; bar.appendChild(morning); }
        style(morning, 'left', value.timeMorningPercent + '%');
      }
    }
  };
  const render = () => {
    if (stopped) return;
    const main = document.querySelector('main.main-surface,main[class*="MainContentSurface"]');
    if (!main) { summary?.remove(); toolbar?.removeAttribute('data-codex-usage-state'); footer?.release(); footer = toolbar = null; visibility(); return; }
    if (!toolbar) {
      footer = acquireFooter(document, owner, getHostState()); toolbar = footer.element;
      summary = document.createElement('span'); summary.className = 'codex-usage-summary'; summary.setAttribute('data-cdtk-owned', 'weekly-usage');
      label = document.createElement('span'); label.className = 'codex-usage-label'; summary.appendChild(label); footer.left.appendChild(summary);
    }
    footer.setHostState(getHostState());
    const weekly = usage?.weekly;
    renderLabel();
    if (!weekly) {
      if (toolbar.dataset.codexUsageState !== 'pending') toolbar.dataset.codexUsageState = 'pending';
    } else {
      if (toolbar.dataset.codexUsageState !== 'ready') toolbar.dataset.codexUsageState = 'ready';
    }
    progress(); visibility();
  };
  function visibility() {
    if ((!toolbar || document.hidden || stopped) && minuteTimer !== null) { view.clearInterval(minuteTimer); minuteTimer = null; }
    if (toolbar && !document.hidden && !stopped && minuteTimer === null) { progress(); minuteTimer = view.setInterval(progress, 60000); }
  }
  document.addEventListener('visibilitychange', visibility);
  return {
    update(snapshot) { if (snapshot && (!usage || snapshot.updatedAt >= usage.updatedAt)) usage = snapshot; render(); },
    setHardReset(snapshot, title) { hardReset = snapshot; hardResetTitle = title; progress(); },
    renderLabel, renderHardResetTitle,
    refresh: render,
    cleanup() { stopped = true; document.removeEventListener('visibilitychange', visibility); visibility(); summary?.remove(); toolbar?.removeAttribute('data-codex-usage-state'); footer?.release(); },
  };
}
