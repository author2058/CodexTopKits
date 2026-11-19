import manifest from './kit.json' with { type: 'json' };

export function createManagerEntry({ document, dependencies, getHostState, onDomChange, i18n }) {
  const messages = { en: { open: 'Open Toolkit settings', issue: '{count} issue found; open details', issues: '{count} issues found; open details' }, 'zh-Hans': { open: '打开工具设置', issue: '发现 {count} 项问题，点击查看详情', issues: '发现 {count} 项问题，点击查看详情' } };
  let lease, control;
  const unmount = () => { control?.close(); control = null; lease?.release(); lease = null; };
  const refresh = () => {
    if (!document.querySelector('main.main-surface,main[class*="MainContentSurface"]')) { unmount(); return; }
    if (!lease) { lease = dependencies.footer.acquire('manager-entry', getHostState()); control = lease.mountManager(count => i18n.t(messages, count === 1 ? 'issue' : count ? 'issues' : 'open', { count })); }
    lease.setHostState(getHostState());
  };
  const unsubscribe = onDomChange(refresh), unsubscribeLocale = i18n.onChange(() => control?.refresh());
  try { refresh(); } catch (error) { unsubscribe(); unsubscribeLocale(); unmount(); throw error; }
  return { close() { unsubscribe(); unsubscribeLocale(); unmount(); } };
}

export default { manifest, create: createManagerEntry };
