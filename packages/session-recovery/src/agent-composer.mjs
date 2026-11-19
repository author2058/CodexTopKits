export function installAgentComposerRestore(document, bridge, assets, onError, onStatus, readConversationIdentity) {
  const window=document.defaultView;
  let stopped=false;
  const state={nativeAssets:assets,backgroundAgentCompatibility:{ok:false},backgroundAgentInteractionActive:false,backgroundAgentConvertedThreads:new Set(),last:null};
  const cleanText=value=>typeof value==='string'?value.replace(/\s+/gu,' ').trim():'';
  const bareThreadId=value=>typeof value==='string'?value.replace(/^local:/,''):null;
  const visiblePanel=node=>node?.getClientRects().length&&window.getComputedStyle(node).visibility!=='hidden';
  const panelThreadIdentity=node=>{const id=node?.getAttribute('data-tab-id')||'',at=id.indexOf(':');return{kind:id.slice(0,at),threadId:bareThreadId(id.slice(at+1))};};
  const appServerRequest=(method,params,source)=>bridge.appServer(method,params,{source});
  const reportBackgroundAgentInteraction=value=>{state.last=value;onStatus();};
    const verifyBackgroundAgentCompatibility = async () => {
      const fetchSource = async (url) => {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error('Codex module fetch failed with HTTP ' + response.status + ': ' + url);
        return response.text();
      };
      const runtime = await state.nativeAssets.runtime();
      let initialUrl, restoration, openTargetUrl, openTargetSource, localPageUrl, localPageSource;
      if (runtime) {
        const registration = await state.nativeAssets.find('background-agent route registration', source => source.includes('restoreBackgroundAgentTabRoute') && source.includes('serialize:'));
        const lazy = registration.source.match(/\.e\((\d+)\)\.then\(\w+\.bind\(\w+,["']([^"']+)["']\)\)/);
        if (!lazy) throw new Error('Codex background-agent restoration chunk registration changed.');
        await runtime.e(Number(lazy[1]));
        const factory = runtime.m[lazy[2]];
        if (typeof factory !== 'function') throw new Error('Codex background-agent restoration module is unavailable.');
        restoration = { url: registration.url + '/' + lazy[2], source: Function.prototype.toString.call(factory) };
        const target = await state.nativeAssets.find('background-agent target resolver', source => source.includes('subAgentActivity') && source.includes('canInteract:!1') && source.includes('getConversationAncestry'));
        const page = await state.nativeAssets.find('background-agent page routing', source => source.includes('onOpenBackgroundAgent') && source.includes('openLocalConversationSubagentsPanel') && source.includes('openLocalConversationBackgroundAgent'));
        initialUrl = registration.url;
        openTargetUrl = target.url; openTargetSource = target.source;
        localPageUrl = page.url; localPageSource = page.source;
      } else {
        initialUrl = await state.nativeAssets.resolve('app-initial');
        if (!initialUrl) throw new Error('Codex renderer bootstrap no longer references a recognizable app-initial module.');
        const initialSource = await state.nativeAssets.read(initialUrl);
        const localPageName = initialSource.match(/local-conversation-page-[A-Za-z0-9_-]+\.js/)?.[0];
        const restorationNames = [...new Set(initialSource.match(/restoration-[A-Za-z0-9_-]+\.js/g) || [])];
        if (restorationNames.length === 0) throw new Error('Codex app-initial no longer references background-agent restoration modules.');
        localPageUrl = localPageName ? new URL(localPageName, initialUrl).href : initialUrl;
        const restorationUrls = restorationNames.map((name) => new URL(name, initialUrl).href);
        const restorationSources = await Promise.all(restorationUrls.map(async (url) => ({ url, source: await fetchSource(url) })));
        const backgroundRestorations = restorationSources.filter((entry) => entry.source.includes('restoreBackgroundAgentTabRoute'));
        if (backgroundRestorations.length !== 1) throw new Error('Codex exposes ' + backgroundRestorations.length + ' background-agent restoration modules; expected exactly one.');
        restoration = backgroundRestorations[0];
        const openTargetMatch = restoration.source.match(/from["']\.\/(open-target-[A-Za-z0-9_-]+\.js)["']/);
        if (!openTargetMatch) throw new Error('Codex background-agent restoration no longer imports a recognizable target resolver.');
        openTargetUrl = new URL(openTargetMatch[1], restoration.url).href;
        [openTargetSource, localPageSource] = await Promise.all([
          fetchSource(openTargetUrl),
          localPageName ? fetchSource(localPageUrl) : initialSource,
        ]);
      }
      const legacyFallbackShape = openTargetSource.includes('subAgentActivity') && openTargetSource.includes('canInteract:!1');
      const liveFirstShape = openTargetSource.includes('.find(e=>e.conversationId===r)??p(')
        || /\.find\(\w+=>\w+\.conversationId===\w+\);if\((?:\w+!=null|null!=\w+)\)return \w+/.test(openTargetSource);
      const historyFirstRestoreShape = restoration.source.includes('let h=o(s,p,u),g=h??c(s,p,m,u)')
        || /let \w+=\w+\([^)]+\),\w+=\w+\?\?await \w+\(/.test(restoration.source)
        || /let (\w+)=\(0,\w+\.\w+\)\([^)]+\),\w+=\1\?\?await \(0,\w+\.\w+\)\(/.test(restoration.source);
      const routeGateShape = localPageSource.includes('onOpenBackgroundAgent') && localPageSource.includes('canInteract');
      if (!legacyFallbackShape || !liveFirstShape || !historyFirstRestoreShape || !routeGateShape) {
        throw new Error('Codex background-agent routing semantics changed; automatic interactive restoration is disabled until the adapter is reviewed.');
      }
      return { ok: true, checkedAt: Date.now(), initialUrl, restorationUrl: restoration.url, openTargetUrl, localPageUrl };
    };
    const backgroundAgentPanelDescriptor = (panel) => {
      if (!panel || !visiblePanel(panel)) return null;
      const { kind, threadId: parentThreadId } = panelThreadIdentity(panel);
      if (kind !== 'subagents' || !parentThreadId) return null;
      let transcript = null;
      let displayName = null;
      for (const element of [panel, ...panel.querySelectorAll('*')]) {
        const fiberKey = Object.getOwnPropertyNames(element).find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? element[fiberKey] : null;
        for (let depth = 0; fiber && depth < 18; depth += 1, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          if (!transcript && typeof props?.conversationId === 'string' && typeof props?.hostId === 'string'
            && props.isReadOnly === true && props.showComposer === false) transcript = props;
          if (transcript && props?.conversationId === transcript.conversationId && typeof props?.displayName === 'string' && props.displayName.trim()) displayName = props.displayName.trim();
        }
        if (transcript && displayName) break;
      }
      return transcript ? { parentThreadId, childThreadId: bareThreadId(transcript.conversationId), hostId: transcript.hostId, displayName: displayName || transcript.conversationId } : null;
    };
    const selectedAuxiliaryCloseHandler = () => {
      const buttons = [...document.querySelectorAll('button[data-app-shell-tab-close-button="true"]')];
      const named = buttons.filter((button) => /subagents/i.test(button.getAttribute('aria-label') || ''));
      const button = named.length === 1 ? named[0] : buttons.length === 1 ? buttons[0] : null;
      if (!button) return null;
      const fiberKey = Object.getOwnPropertyNames(button).find((key) => key.startsWith('__reactFiber$'));
      const handler = fiberKey ? button[fiberKey]?.memoizedProps?.onClick : null;
      return typeof handler === 'function' && Function.prototype.toString.call(handler).includes('.closeTab(') ? handler : null;
    };
    const backgroundAgentRouteOpener = () => {
      const callbacks = new Set;
      for (const element of document.querySelectorAll('main *')) {
        const fiberKey = Object.getOwnPropertyNames(element).find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? element[fiberKey] : null;
        for (let depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          if (typeof props?.onOpenBackgroundAgent === 'function' && props.conversationId == null && props.isReadOnly === false && props.showComposer === true) callbacks.add(props.onOpenBackgroundAgent);
        }
      }
      return callbacks.size === 1 ? [...callbacks][0] : null;
    };
    const waitForBackgroundAgentCondition = async (predicate, timeoutMs, label) => {
      const started = performance.now();
      while (!predicate()) {
        if (stopped) throw new Error('Agent composer restoration stopped.');
        if (performance.now() - started >= timeoutMs) throw new Error(label + ' timed out.');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    const restoreInteractiveBackgroundAgent = async (descriptor) => {
      const result = await appServerRequest('thread/read', { threadId: descriptor.childThreadId, includeTurns: false }, 'background_agent_interaction_check');
      if (stopped) return { skipped: true, reason: 'stopped' };
      const thread = result?.thread;
      const verifiedParentThreadId = bareThreadId(thread?.parentThreadId || thread?.source?.subAgent?.thread_spawn?.parent_thread_id);
      if (verifiedParentThreadId !== descriptor.parentThreadId) return { skipped: true, reason: 'parent-mismatch', verifiedParentThreadId };
      const closeHandler = selectedAuxiliaryCloseHandler();
      if (!closeHandler) throw new Error('Codex Subagents close action is unavailable or ambiguous.');
      closeHandler();
      await waitForBackgroundAgentCondition(() => !document.querySelector('[role="tabpanel"][data-tab-id="subagents:' + CSS.escape(descriptor.parentThreadId) + '"]'), 2000, 'Closing the read-only Subagents panel');
      const opener = backgroundAgentRouteOpener();
      if (!opener) throw new Error('Codex parent-thread background-agent route callback is unavailable or ambiguous.');
      opener({ canInteract: true, conversationId: descriptor.childThreadId, displayName: descriptor.displayName });
      await waitForBackgroundAgentCondition(() => {
        const panel = document.querySelector('[role="tabpanel"][data-tab-id="background-agent:' + CSS.escape(descriptor.childThreadId) + '"]');
        return Boolean(panel?.querySelector('[role="textbox"][contenteditable="true"],textarea'));
      }, 2500, 'Opening the interactive background-agent panel');
      return { skipped: false, parentThreadId: descriptor.parentThreadId, childThreadId: descriptor.childThreadId };
    };
    const ensureInteractiveBackgroundAgentPanel = () => {
      if (stopped || state.backgroundAgentInteractionActive || state.backgroundAgentCompatibility?.ok !== true) return;
      const panel = [...document.querySelectorAll('[role="tabpanel"][data-tab-id^="subagents:"]')].find(visiblePanel);
      const descriptor = backgroundAgentPanelDescriptor(panel);
      if (!descriptor || !descriptor.childThreadId || state.backgroundAgentConvertedThreads.has(descriptor.childThreadId)) return;
      state.backgroundAgentInteractionActive = true;
      restoreInteractiveBackgroundAgent(descriptor).then((result) => {
        if (!result.skipped) state.backgroundAgentConvertedThreads.add(descriptor.childThreadId);
        reportBackgroundAgentInteraction({ ok: true, checkedAt: Date.now(), ...result });
      }).catch((error) => {
        if (!stopped) { reportBackgroundAgentInteraction({ ok: false, checkedAt: Date.now(), name: error.name, message: error.message, stack: error.stack }); onError(error); }
      }).finally(() => { state.backgroundAgentInteractionActive = false; });
    };
  let started=false,finishReady;
  const ready=new Promise(resolve=>{finishReady=resolve;});
  const refresh=()=>{
    if(stopped)return;
    if(!started){
      if(!readConversationIdentity(document))return;
      started=true;
      void verifyBackgroundAgentCompatibility().then(value=>{if(!stopped){state.backgroundAgentCompatibility=value;ensureInteractiveBackgroundAgentPanel();onStatus();}}).catch(error=>{if(!stopped){state.backgroundAgentCompatibility={ok:false,name:error.name,message:error.message,stack:error.stack};onError(error);}}).finally(finishReady);
    }else ensureInteractiveBackgroundAgentPanel();
  };
  refresh();
  return{ready,refresh,status:()=>({waitingForConversation:!started,compatibility:state.backgroundAgentCompatibility,last:state.last,active:state.backgroundAgentInteractionActive}),cleanup(){stopped=true;finishReady();}};
}
