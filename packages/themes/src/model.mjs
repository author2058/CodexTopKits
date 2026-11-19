export class ThemeConfigError extends Error {}

export function validateMap(raw) {
  const fail = message => { throw new ThemeConfigError(message); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) fail('主题配置必须是 version 为 1 的对象。');
  for (const key of ['themes', 'projects', 'tasks']) if (!raw[key] || typeof raw[key] !== 'object' || Array.isArray(raw[key])) fail('主题配置缺少有效的 ' + key + ' 对象。');
  const ownsTheme = value => typeof value === 'string' && Object.hasOwn(raw.themes, value);
  if (raw.defaultTheme !== 'native' && !ownsTheme(raw.defaultTheme)) fail('默认颜色必须是原生或已存在的主题。');
  const map = { ...raw, enabledColors: raw.enabledColors === undefined ? { accent: true, canvas: true, surface: true, sidebar: true } : raw.enabledColors, uiFontSizeOverride: raw.uiFontSizeOverride ?? null };
  if (!map.enabledColors || typeof map.enabledColors !== 'object' || Array.isArray(map.enabledColors)) fail('全局颜色开关必须是对象。');
  for (const channel of ['accent', 'canvas', 'surface', 'sidebar']) if (typeof map.enabledColors[channel] !== 'boolean') fail('颜色开关 ' + channel + ' 必须是布尔值。');
  if (map.uiFontSizeOverride !== null && (!Number.isInteger(map.uiFontSizeOverride) || map.uiFontSizeOverride < 11 || map.uiFontSizeOverride > 24)) fail('UI 字号必须跟随 Codex，或为 11 到 24 的整数。');
  for (const [id, theme] of Object.entries(map.themes)) {
    if (!/^[a-z0-9_-]{1,80}$/i.test(id) || ['native', 'inherit'].includes(id) || !theme || typeof theme !== 'object' || Array.isArray(theme)) fail('无效的主题名称：' + id);
    for (const channel of ['accent', 'canvas', 'surface', 'sidebar']) if (!/^#[0-9a-f]{6}$/i.test(theme[channel] ?? '')) fail('主题 ' + id + ' 的 ' + channel + ' 必须是六位十六进制颜色。');
  }
  for (const section of ['projects', 'tasks']) for (const [key, value] of Object.entries(map[section])) {
    if (!key || key.length > 300 || typeof value !== 'string' || !(value === 'native' || section === 'tasks' && value === 'inherit' || ownsTheme(value))) fail('无效的 ' + section + ' 配色：' + key);
  }
  return map;
}

export function canonicalTaskKey(value, hostId = 'local') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.includes(':') ? text : hostId + ':' + text : null;
}

export function projectNameForThread(taskKey, assignments, projects, cwd, threadProjectId = null) {
  const own = (container, key) => container && Object.hasOwn(container, key) ? container[key] : null;
  const bare = taskKey?.split(':').at(-1);
  const assignment = own(assignments, taskKey) ?? own(assignments, bare);
  const projectId = threadProjectId || (typeof assignment === 'string' ? assignment : assignment?.projectId || assignment?.id);
  const records = Array.isArray(projects) ? projects : Object.values(projects || {});
  const direct = projectId ? own(projects, projectId) || records.find(record => record?.id === projectId) : null;
  if (typeof direct?.name === 'string') return direct.name;
  const normalize = value => {
    if (typeof value !== 'string') return null;
    const normalized = value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
    return normalized.startsWith('\\\\?\\') ? normalized.slice(4) : normalized;
  };
  const current = normalize(cwd);
  if (!current) return null;
  const matched = records.flatMap(record => {
    const roots = (Array.isArray(record?.rootPaths) ? record.rootPaths : []).map(normalize).filter(value => value && (current === value || current.startsWith(value + '\\')));
    return roots.length ? [{ name: record.name, length: Math.max(...roots.map(value => value.length)) }] : [];
  });
  matched.sort((left, right) => right.length - left.length);
  return matched[0]?.name || null;
}

export function resolveTheme(map, { taskKey = null, projectName = null } = {}) {
  const own = (container, key) => key && Object.hasOwn(container, key) ? container[key] : null;
  const taskAssignment = taskKey ? own(map.tasks, taskKey) || 'inherit' : null;
  const projectAssignment = projectName ? own(map.projects, projectName) || map.defaultTheme : taskKey ? map.defaultTheme : 'native';
  const themeId = taskAssignment && taskAssignment !== 'inherit' ? taskAssignment : projectAssignment;
  return { taskAssignment, projectAssignment, themeId, theme: themeId === 'native' ? null : own(map.themes, themeId) };
}
