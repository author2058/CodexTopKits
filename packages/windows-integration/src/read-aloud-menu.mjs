export function installReadAloudMenu(document, send, onError, label = () => '用 Microsoft Edge 打开并朗读') {
  const window = document.defaultView, state = { readAloudTreeHost: null, readAloudTreeHandlerRef: null, readAloudTreeWrapper: null };
  const refresh = () => {
      if (state.readAloudListener) { state.ensureReadAloudTreeHandler?.(); return; }
      let host = document.querySelector('file-tree-container');
      const actionId = 'cdtk-read-aloud';
      const appendReadAloudItem = (items) => [...(Array.isArray(items) ? items : []), { id: actionId + '-separator', type: 'separator', label: '' }, { id: actionId, label: label() }];
      const itemLabel = (item) => item.nativeLabel || item.label || item.message?.defaultMessage?.replace(/\{(\w+)\}/g, (_, key) => item.messageValues?.[key] ?? '') || item.id;
      const nativeItems = (items) => items.map((item) => item.type === 'separator' ? { id: item.id, type: 'separator', label: '' } : ({ id: item.id, type: item.type === 'checkbox' ? 'checkbox' : undefined, label: itemLabel(item), enabled: item.enabled !== false, submenu: item.submenu ? nativeItems(item.submenu) : undefined }));
      const findItem = (items, id) => { for (const item of items) { if (item.id === id) return item; const found = item.submenu && findItem(item.submenu, id); if (found) return found; } return null; };
      const dispatchReadAloud = (context) => {
        send({ kind: 'read-aloud', path: context.filePath, cwd: context.cwd });
      };
      const originalMenu = window.electronBridge?.showContextMenu?.bind(window.electronBridge);
      if (!originalMenu) throw new Error('Codex 原生右键菜单接口不可用。');
      const menuProviderFor = (element) => {
        const fiberKey = element && Object.getOwnPropertyNames(element).find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? element[fiberKey] : null;
        while (fiber) {
          if (typeof fiber.memoizedProps?.getItems === 'function') return fiber.memoizedProps;
          fiber = fiber.return;
        }
        return null;
      };
      const cwdForTree = () => {
        const fiberKey = host && Object.getOwnPropertyNames(host).find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? host[fiberKey] : null;
        while (fiber) { if (typeof fiber.memoizedProps?.cwd === 'string') return fiber.memoizedProps.cwd; fiber = fiber.return; }
        return null;
      };
      const treeMenuHandlerRef = () => {
        const fiberKey = host && Object.getOwnPropertyNames(host).find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? host[fiberKey] : null;
        while (fiber) {
          let hook = fiber.memoizedState;
          while (hook) {
            const candidate = hook.memoizedState;
            const handler = candidate && typeof candidate === 'object' ? candidate.current : null;
            if (typeof handler === 'function') {
              if (handler.__codexDynamicThemeReadAloudWrapper) return candidate;
              const source = Function.prototype.toString.call(handler);
              if (source.includes('showContextMenu') && source.includes('pointercancel')) return candidate;
            }
            hook = hook.next;
          }
          fiber = fiber.return;
        }
        return null;
      };
      const showAugmentedMenu = async (context, provider) => {
        try {
          await provider?.onBeforeOpen?.();
          const items = typeof provider?.getItems === 'function' ? await provider.getItems() : [];
          const selected = await originalMenu(nativeItems(appendReadAloudItem(items)));
          if (selected?.id === actionId) {
            dispatchReadAloud(context);
            state.readAloudLast = { stage: 'launch-dispatched', ...context, itemCount: items.length };
          } else {
            await findItem(items, selected?.id)?.onSelect?.();
            state.readAloudLast = { stage: 'native-action-selected', ...context, itemCount: items.length, selectedId: selected?.id || null };
          }
        } catch (error) {
          state.readAloudLast = { stage: 'menu-error', ...context, name: error.name, message: error.message, stack: error.stack }; onError(error);
        }
      };
      state.readAloudListener = (event) => {
        const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
        const fileReference = eventPath.find((node) => node?.nodeType === Node.ELEMENT_NODE && node.getAttribute('data-file-reference') === 'true');
        if (!fileReference || event.__codexDynamicThemeReadAloudHandled) return;
        const chatPath = fileReference.getAttribute('data-prompt-link-href') || '';
        if (!chatPath.toLowerCase().endsWith('.md')) return;
        const provider = menuProviderFor(fileReference);
        if (!provider) { onError(new Error('聊天文件的原生菜单项接口不可用，保留原生菜单。')); return; }
        event.__codexDynamicThemeReadAloudHandled = true;
        event.preventDefault(); event.stopImmediatePropagation();
        const context = { selectedRelativePath: '', chatPath, filePath: chatPath, cwd: null };
        state.readAloudLast = { stage: 'menu-opened', ...context, source: 'chat' };
        void showAugmentedMenu(context, provider);
      };
      state.readAloudTreeListener = (event) => {
        const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
        const selectedItem = eventPath.find((node) => node?.nodeType === Node.ELEMENT_NODE && node.getAttribute('data-item-type') === 'file');
        const selectedRelativePath = selectedItem?.getAttribute('data-item-path') || '';
        if (!selectedItem || !selectedRelativePath || !selectedRelativePath.toLowerCase().endsWith('.md')) return;
        const cwd = cwdForTree();
        const context = { selectedRelativePath, chatPath: '', filePath: [cwd, selectedRelativePath].filter(Boolean).join('/'), cwd };
        state.readAloudTreeContext = { context, event, capturedAt: performance.now() };
        state.readAloudLast = { stage: 'tree-context-captured', ...context, source: 'file-tree' };
      };
      state.ensureReadAloudTreeHandler = () => {
        const nextHost = document.querySelector('file-tree-container');
        const nextTreeHost = nextHost?.shadowRoot || nextHost || null;
        if (nextTreeHost !== state.readAloudTreeHost) {
          state.readAloudTreeHost?.removeEventListener('contextmenu', state.readAloudTreeListener, true);
          if (state.readAloudTreeHandlerRef?.current === state.readAloudTreeWrapper) state.readAloudTreeHandlerRef.current = state.readAloudTreeOriginalHandler;
          host = nextHost;
          state.readAloudTreeHost = nextTreeHost;
          state.readAloudTreeHandlerRef = null;
          state.readAloudTreeOriginalHandler = null;
          state.readAloudTreeWrapper = null;
          state.readAloudTreeHost?.addEventListener('contextmenu', state.readAloudTreeListener, true);
        } else host = nextHost;
        if (!host) return false;
        if (state.readAloudTreeHandlerRef?.current === state.readAloudTreeWrapper && state.readAloudTreeWrapper) return true;
        const handlerRef = treeMenuHandlerRef();
        if (!handlerRef) { state.readAloudLast = { stage: 'tree-handler-not-found' }; throw new Error('文件浏览器的原生右键菜单入口已变化。'); }
        if (handlerRef.current?.__codexDynamicThemeReadAloudWrapper) return true;
        const originalHandler = handlerRef.current;
        const wrapper = async (event) => {
          const captured = state.readAloudTreeContext;
          state.readAloudTreeContext = null;
          if (!captured || performance.now() - captured.capturedAt > 1500 || !captured.context?.filePath?.toLowerCase().endsWith('.md')) return originalHandler(event);
          const provider = menuProviderFor(host);
          if (!provider) { onError(new Error('文件浏览器的原生菜单项接口不可用，保留原生菜单。')); return originalHandler(event); }
          event?.preventDefault?.();
          document.dispatchEvent(new PointerEvent('pointercancel'));
          state.readAloudLast = { stage: 'menu-opening', ...captured.context, source: 'file-tree-react-handler' };
          await showAugmentedMenu(captured.context, provider);
        };
        Object.defineProperty(wrapper, '__codexDynamicThemeReadAloudWrapper', { value: true });
        state.readAloudTreeHandlerRef = handlerRef;
        state.readAloudTreeOriginalHandler = originalHandler;
        state.readAloudTreeWrapper = wrapper;
        handlerRef.current = wrapper;
        return true;
      };
      state.readAloudHosts = [document];
      for (const listenerHost of state.readAloudHosts) listenerHost.addEventListener('contextmenu', state.readAloudListener, true);
      state.ensureReadAloudTreeHandler();
    };

  return { refresh, status: () => state.readAloudLast || null, cleanup() {
    document.removeEventListener('contextmenu', state.readAloudListener, true);
    state.readAloudTreeHost?.removeEventListener('contextmenu', state.readAloudTreeListener, true);
    if (state.readAloudTreeHandlerRef?.current === state.readAloudTreeWrapper) state.readAloudTreeHandlerRef.current = state.readAloudTreeOriginalHandler;
  } };
}
