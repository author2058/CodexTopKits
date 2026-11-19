// Runs in the renderer. Preserve the native snapshot, handlers and menu keyboard behavior.
export function nativeQuitItem(snapshot) {
  const items = snapshot?.['file-menu'], quit = Array.isArray(items) ? items.at(-1) : null;
  if (!Array.isArray(items) || quit?.type !== 'item' || !Number.isSafeInteger(quit.nativeCommandId)
    || !/^(?:Quit|Exit) (?:ChatGPT|Codex)$|^退出(?: ChatGPT| Codex)?$/i.test(quit.label) || quit.enabled !== true) {
    throw Object.assign(new Error('The native File → Quit command has changed. Restart is unavailable.'), { code: 'CODEX_QUIT_MENU_CHANGED' });
  }
  return quit;
}

export function installRestartMenu(services, { restart, onError, label = () => 'Restart with CodexTopKits' }, findQuit) {
  const original = services.applicationMenu;
  if (!original || typeof original.getSnapshot !== 'function' || typeof original.invokeItem !== 'function') throw new Error('The native application menu is unavailable.');
  const commandId = -2147432001;
  let closed = false, restarting = false, available = false;
  const getSnapshot = async (...args) => {
    const snapshot = await original.getSnapshot(...args);
    if (closed) return snapshot;
    let quit;
    try { quit = findQuit(snapshot); }
    catch (error) { if (error.code !== 'CODEX_QUIT_MENU_CHANGED') throw error; available = false; onError(error); return snapshot; }
    const items = snapshot['file-menu'];
    if (Object.values(snapshot).some(list => list.some(item => item.nativeCommandId === commandId))) {
      available = false; onError(Object.assign(new Error('Restart menu command ID is already in use.'), { code: 'CODEX_RESTART_COMMAND_COLLISION' })); return snapshot;
    }
    const index = items.indexOf(quit), entries = [...items];
    entries.splice(index, 0, { type: 'item', nativeCommandId: commandId, label: label(), accelerator: null, enabled: !restarting });
    available = true; onError(null);
    return { ...snapshot, 'file-menu': entries };
  };
  const invokeItem = (id, ...args) => {
    if (id !== commandId || !available) return original.invokeItem(id, ...args);
    if (closed || restarting) return;
    restarting = true;
    return Promise.resolve().then(restart).then(value => { restarting = false; onError(null); return value; }, error => { restarting = false; onError(error); throw error; });
  };
  const proxy = new Proxy(original, { get(target, key, receiver) { return key === 'getSnapshot' ? getSnapshot : key === 'invokeItem' ? invokeItem : Reflect.get(target, key, receiver); } });
  services.applicationMenu = proxy;
  if (services.applicationMenu !== proxy) throw new Error('The native application menu cannot be extended.');
  return {
    getSnapshot,
    close() { closed = true; if (services.applicationMenu !== proxy) throw new Error('The restart menu owner changed.'); services.applicationMenu = original; },
  };
}
