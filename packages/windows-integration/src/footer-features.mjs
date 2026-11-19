export function installWindowTabs(document, acquire, getState, activate, middleEllipsis, css, translate = key => ({ switchWindows: '切换 Codex 窗口', running: '正在运行', unread: '未读' })[key]) {
  const view = document.defaultView, measurements = new Map();
  let lease, picker, measure;
  const style = document.createElement('style'); style.setAttribute('data-cdtk-owned', 'window-tabs'); style.textContent = css; document.head.appendChild(style);
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const attribute = (node, key, value) => { if (node.getAttribute(key) !== value) node.setAttribute(key, value); };
  const unmount = () => { picker?.remove(); measure?.remove(); lease?.release(); lease = picker = measure = null; };
  const renderText = () => {
    if (!picker) return;
    attribute(picker, 'aria-label', translate('switchWindows'));
    for (const button of picker.children) {
      const status = button.lastElementChild, svg = status.querySelector('svg');
      if (svg && status.dataset.state !== 'idle') attribute(svg, 'aria-label', translate(status.dataset.state));
    }
  };
  const refresh = () => {
    if (!document.querySelector('main.main-surface,main[class*="MainContentSurface"]')) { unmount(); return; }
    if (!lease) {
      lease = acquire('window-tabs'); picker = document.createElement('div'); picker.id = 'cdtk-window-switcher'; picker.setAttribute('data-cdtk-owned', 'window-tabs');
      picker.setAttribute('role', 'toolbar'); lease.center.appendChild(picker);
      picker.addEventListener('click', event => { const button = event.target.closest('button[data-target-id]'); if (button) { event.preventDefault(); activate(button.dataset.targetId); } });
      measure = document.createElement('span'); measure.setAttribute('data-cdtk-owned', 'window-tabs'); measure.setAttribute('aria-hidden', 'true');
      measure.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;white-space:pre;left:-9999px;top:-9999px'; document.body.appendChild(measure);
    }
    const state = getState() || {}, rows = state.windows || [], ids = new Set(rows.map(value => value.targetId));
    for (const node of [...picker.children]) if (!ids.has(node.dataset.targetId)) node.remove();
    for (const [index, entry] of rows.entries()) {
      let button = [...picker.children].find(node => node.dataset.targetId === entry.targetId);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'cdtk-window-tab'; button.dataset.targetId = entry.targetId;
        if (entry.targetId === state.targetId) {
          button.id = 'cdtk-window-' + entry.targetId;
          const moon = lease.right.querySelector('.cdtk-auto-sleep'); if (moon?.id === button.id) moon.id = '';
        }
        const label = document.createElement('span'), status = document.createElement('span'); label.className = 'cdtk-window-label'; status.className = 'cdtk-window-status'; button.append(label, status);
      }
      if (picker.children[index] !== button) picker.insertBefore(button, picker.children[index] || null);
      attribute(button, 'aria-current', String(entry.targetId === state.targetId)); attribute(button, 'title', entry.title);
      if (button.style.getPropertyValue('--cdtk-window-color') !== entry.color) button.style.setProperty('--cdtk-window-color', entry.color);
      const label = button.firstElementChild, status = button.lastElementChild, computed = view.getComputedStyle(label);
      const cacheKey = JSON.stringify([entry.title, computed.font, computed.letterSpacing, computed.wordSpacing]);
      if (!measurements.has(cacheKey)) {
        measure.style.font = computed.font; measure.style.letterSpacing = computed.letterSpacing; measure.style.wordSpacing = computed.wordSpacing;
        measurements.set(cacheKey, middleEllipsis(entry.title, 190, value => { text(measure, value); return Math.ceil(measure.getBoundingClientRect().width); }));
      }
      text(label, measurements.get(cacheKey));
      const running = entry.status === 'active', name = running ? 'running' : entry.unread ? 'unread' : 'idle';
      if (status.dataset.state !== name) {
        status.dataset.state = name;
        status.innerHTML = running ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="正在运行"><path d="M12 3a9 9 0 1 1-8.5 12"/><path d="M4 4v5h5"/></svg>'
          : entry.unread ? '<svg viewBox="0 0 24 24" aria-label="未读"><circle cx="12" cy="12" r="5" fill="#60a5fa"/></svg>' : '';
      }
    }
    renderText();
  };
  view.addEventListener('resize', refresh);
  return { refresh, renderText, cleanup() { view.removeEventListener('resize', refresh); unmount(); style.remove(); } };
}

export function installAutoSleepButton(document, acquire, getState, toggle, css, translate = (key, values) => ({ error: '自动睡眠失败：' + values?.error, enabled: '全部会话结束并静置一分钟后睡眠；点击取消', disabled: '自动睡眠已关闭，点击开启' })[key]) {
  let lease, button;
  const style = document.createElement('style'); style.setAttribute('data-cdtk-owned', 'auto-sleep'); style.textContent = css; document.head.appendChild(style);
  const unmount = () => { button?.remove(); lease?.release(); lease = button = null; };
  const renderStateText = state => {
    if (!button) return;
    const title = state.autoSleep?.error ? translate('error', { error: state.autoSleep.error }) : translate(state.autoSleep?.enabled ? 'enabled' : 'disabled');
    for (const key of ['title', 'aria-label']) if (button.getAttribute(key) !== title) button.setAttribute(key, title);
  };
  const renderText = () => renderStateText(getState() || {});
  const refresh = () => {
    if (!document.querySelector('main.main-surface,main[class*="MainContentSurface"]')) { unmount(); return; }
    const state = getState() || {};
    if (!lease) {
      lease = acquire('auto-sleep'); button = document.createElement('button'); button.type = 'button'; button.className = 'cdtk-auto-sleep'; button.textContent = '🌙';
      const marker = state.targetId ? 'cdtk-window-' + state.targetId : '';
      const picker = lease.center.querySelector('#cdtk-window-switcher');
      if (marker && ![...(picker?.children || [])].some(node => node.id === marker)) button.id = marker;
      button.setAttribute('data-cdtk-owned', 'auto-sleep'); button.addEventListener('click', () => toggle(!getState()?.autoSleep?.enabled)); lease.right.appendChild(button);
    }
    const marker = state.targetId ? 'cdtk-window-' + state.targetId : '';
    const picker = lease.center.querySelector('#cdtk-window-switcher');
    const tabHasMarker = marker && [...(picker?.children || [])].some(node => node.id === marker);
    const nextId = tabHasMarker ? '' : marker; if (button.id !== nextId) button.id = nextId;
    const attributes = { 'aria-pressed': String(state.autoSleep?.enabled === true), 'data-error': String(Boolean(state.autoSleep?.error)) };
    for (const [key, value] of Object.entries(attributes)) if (button.getAttribute(key) !== value) button.setAttribute(key, value);
    renderStateText(state);
  };
  return { refresh, renderText, cleanup() { unmount(); style.remove(); } };
}

export function createWindowTabs({ document, dependencies, onDomChange, onRuntimeState, getRuntimeState, dispatch, i18n }, { installWindowTabs, middleEllipsis, windowTabsCss }) {
  if (typeof i18n?.t !== 'function' || typeof i18n?.onChange !== 'function') throw new Error('window-tabs requires Core 0.3.39 or later.');
  const messages = {
    en: { switchWindows: 'Switch Codex windows', running: 'Running', unread: 'Unread' },
    'zh-Hans': { switchWindows: '切换 Codex 窗口', running: '正在运行', unread: '未读' },
  };
  const ui = installWindowTabs(document, owner => dependencies.footer.acquire(owner), getRuntimeState,
    targetId => dispatch({ kind: 'activate', targetId }), middleEllipsis, windowTabsCss(), key => i18n.t(messages, key));
  let mounted = false;
  const refreshMount = () => { const next = !!document.querySelector('main.main-surface,main[class*="MainContentSurface"]'); if (next !== mounted) { mounted = next; ui.refresh(); } };
  let unmount, unsubscribe, unsubscribeLocale;
  try { unsubscribeLocale = i18n.onChange(ui.renderText); unmount = onDomChange(refreshMount); unsubscribe = onRuntimeState(ui.refresh); refreshMount(); }
  catch (error) { unmount?.(); unsubscribe?.(); unsubscribeLocale?.(); ui.cleanup(); throw error; }
  return { close() { unmount(); unsubscribe(); unsubscribeLocale(); ui.cleanup(); } };
}

export function createAutoSleep({ document, dependencies, onDomChange, onRuntimeState, getRuntimeState, dispatch, i18n }, { installAutoSleepButton, autoSleepCss }) {
  if (typeof i18n?.t !== 'function' || typeof i18n?.onChange !== 'function') throw new Error('auto-sleep requires Core 0.3.39 or later.');
  const messages = {
    en: { error: 'Automatic sleep failed: {error}', enabled: 'Sleep after all conversations finish and remain idle for one minute; click to cancel', disabled: 'Automatic sleep is off; click to enable' },
    'zh-Hans': { error: '自动睡眠失败：{error}', enabled: '全部会话结束并静置一分钟后睡眠；点击取消', disabled: '自动睡眠已关闭，点击开启' },
  };
  const ui = installAutoSleepButton(document, owner => dependencies.footer.acquire(owner), getRuntimeState,
    enabled => dispatch({ kind: 'sleep-toggle', enabled }), autoSleepCss(), (key, values) => i18n.t(messages, key, values));
  let mounted = false;
  const refreshMount = () => { const next = !!document.querySelector('main.main-surface,main[class*="MainContentSurface"]'); if (next !== mounted) { mounted = next; ui.refresh(); } };
  let unmount, unsubscribe, unsubscribeLocale;
  try { unsubscribeLocale = i18n.onChange(ui.renderText); unmount = onDomChange(refreshMount); unsubscribe = onRuntimeState(ui.refresh); refreshMount(); }
  catch (error) { unmount?.(); unsubscribe?.(); unsubscribeLocale?.(); ui.cleanup(); throw error; }
  return { close() { unmount(); unsubscribe(); unsubscribeLocale(); ui.cleanup(); } };
}
