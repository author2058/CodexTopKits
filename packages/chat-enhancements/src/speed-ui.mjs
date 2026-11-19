export function installSpeedUi(document, tracker, currentThreadKey, onError, onChanged = () => {}, labels = null) {
  const view = document.defaultView, getComputedStyle = element => view.getComputedStyle(element);
  const bareThreadId = value => typeof value === 'string' ? value.split(':').at(-1) : null;
    const visiblePanel = (element) => {
      if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
      const rect = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 && css.display !== 'none' && css.visibility !== 'hidden';
    };
    const outputConversationPanels = () => {
      const panels = [];
      const auxiliaryPanelSelector = '[role="tabpanel"][data-tab-id^="background-agent:"],[role="tabpanel"][data-tab-id^="sidechat:"],[role="tabpanel"][data-tab-id^="subagents:"]';
      const mainViewport = [...document.querySelectorAll('[data-app-action-timeline-scroll],.thread-scroll-container')]
        .find((element) => !element.closest(auxiliaryPanelSelector) && visiblePanel(element));
      if (mainViewport) {
        const annotated = [...mainViewport.querySelectorAll('[data-response-annotation-conversation]')].at(-1)?.getAttribute('data-response-annotation-conversation');
        const threadId = bareThreadId(annotated) || bareThreadId(currentThreadKey());
        if (threadId) panels.push({ key: 'main:' + threadId, threadId, host: mainViewport.parentElement || mainViewport, viewport: mainViewport, content: mainViewport.querySelector('[data-thread-find-target="conversation"]') || mainViewport.querySelector('[data-thread-user-message-navigation-content]'), footer: mainViewport.querySelector('[data-thread-scroll-footer="true"]') || document.querySelector('[data-thread-scroll-footer="true"]') });
      }
      for (const host of document.querySelectorAll(auxiliaryPanelSelector)) {
        if (!visiblePanel(host)) continue;
        const tabId = host.getAttribute('data-tab-id') || '';
        const separator = tabId.indexOf(':');
        const kind = separator > 0 ? tabId.slice(0, separator) : 'panel';
        const viewport = host.querySelector('[data-app-action-timeline-scroll],.thread-scroll-container');
        const content = viewport?.querySelector('[data-thread-find-target="conversation"]') || viewport?.querySelector('[data-thread-user-message-navigation-content]');
        const annotated = [...(viewport?.querySelectorAll('[data-response-annotation-conversation]') || [])].at(-1)?.getAttribute('data-response-annotation-conversation');
        const threadId = kind === 'subagents' ? bareThreadId(annotated) : bareThreadId(separator > 0 ? tabId.slice(separator + 1) : '');
        if (threadId && viewport && content && visiblePanel(viewport)) panels.push({ key: kind + ':' + threadId, threadId, host, viewport, content, footer: host.querySelector('[data-thread-scroll-footer="true"]') });
      }
      return panels;
    };
    const outputSpeedAnchors = (panel) => {
      const { viewport, content, footer } = panel || {};
      if (!viewport || !content) return null;
      const viewportRect = viewport.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const footerRect = footer?.getBoundingClientRect();
      const footerOverlaps = footerRect && footerRect.top > viewportRect.top && footerRect.top < viewportRect.bottom;
      return {
        left: Math.max(viewportRect.left + 10, contentRect.left),
        right: Math.max(8, view.innerWidth - Math.min(viewportRect.right - 10, contentRect.right)),
        bottom: Math.max(8, view.innerHeight - (footerOverlaps ? footerRect.top : viewportRect.bottom) + 10),
        maxWidth: Math.max(120, Math.min(contentRect.width, viewportRect.right - Math.max(viewportRect.left + 10, contentRect.left))),
      };
    };
  const tags = new Map(), sizes = new WeakMap();
  const renderText = () => {
    for (const { node, values } of tags.values()) {
      if (!values) continue;
      const names = labels ? labels() : { generation: '生成', endToEnd: '端到端', first: '首响', title: '生成速度：对应响应的原生输出 token 数与首末模型内容的时间；端到端速度另计请求等待时间。' };
      const text = names.generation + ' ' + values.generation + ' tok/s · ' + names.endToEnd + ' ' + values.endToEnd + ' tok/s · ' + names.first + ' ' + values.first + values.pending;
      if (node.textContent !== text) node.textContent = text;
      if (node.title !== names.title) node.title = names.title;
    }
  };
  let frame = null, stopped = false, geometry = [], observed = new Map(), dirty = true, signature = null;
  const dataSignature = () => JSON.stringify([...tags].map(([key, value]) => {
    const record=tracker.read(value.threadId);
    return [key,record?.generationRate,record?.endToEndRate,record?.ttftMs,record?.measurementPending];
  }));
  const resize = new view.ResizeObserver(entries => {
    let changed=false;
    for(const entry of entries){
      const height=observed.get(entry.target),size=entry.contentRect.width+':'+(height?entry.contentRect.height:'');
      if(sizes.get(entry.target)!==size){sizes.set(entry.target,size);changed=true;}
    }
    if(changed)refresh();
  });
  const render = () => {
    if(stopped||document.hidden)return;
    if(dirty){
      dirty=false;
      const panels=outputConversationPanels();
      geometry=panels.map(panel=>({panel,anchor:outputSpeedAnchors(panel)}));
      const next=new Map();
      for(const panel of panels)for(const [element,height] of [[panel.host,true],[panel.viewport,true],[panel.content,false],[panel.footer,true]])if(element)next.set(element,next.get(element)||height);
      if(next.size!==observed.size||[...next].some(([element,height])=>observed.get(element)!==height)){
        resize.disconnect();observed=next;for(const element of observed.keys())resize.observe(element);
      }
    }
    const retained=new Set();
    for(const {panel,anchor} of geometry){
      if(!anchor)continue;retained.add(panel.key);
      let owned=tags.get(panel.key);
      if(!owned){const node=document.createElement('span');node.className='codex-output-token-speed';node.dataset.codexOutputPanel=panel.key;node.dataset.cdtkChatOwned='';document.body.appendChild(node);owned={node,threadId:panel.threadId};tags.set(panel.key,owned);}
      const {node}=owned,record=tracker.read(panel.threadId);
      const rate=value=>Number.isFinite(value)?value.toFixed(1):'—';
      const ttft=Number.isFinite(record?.ttftMs)?record.ttftMs>=1000?(record.ttftMs/1000).toFixed(1)+' s':Math.round(record.ttftMs)+' ms':'—';
      owned.values={generation:rate(record?.generationRate),endToEnd:rate(record?.endToEndRate),first:ttft,pending:record?.measurementPending?'...':''};
      for(const [name,value] of [['left',Math.round(anchor.left)+'px'],['bottom',Math.round(anchor.bottom)+'px'],['max-width',Math.round(anchor.maxWidth)+'px'],['overflow','hidden'],['text-overflow','ellipsis'],['display','block']])if(node.style.getPropertyValue(name)!==value)node.style.setProperty(name,value);
    }
    for(const [key,value] of tags)if(!retained.has(key)){value.node.remove();tags.delete(key);}
    renderText(); signature=dataSignature();
    onChanged();
  };
  const schedule = () => { if(!stopped&&frame===null)frame=view.requestAnimationFrame(()=>{frame=null;try{render();}catch(error){cleanup();onError(error);}}); };
  const refresh = () => { dirty=true;schedule(); };
  const update = () => { if(signature!==dataSignature())schedule(); };
  const visibility = () => { if(!document.hidden)refresh(); };
  function cleanup(){if(stopped)return;stopped=true;if(frame!==null)view.cancelAnimationFrame(frame);resize.disconnect();view.removeEventListener('resize',refresh);document.removeEventListener('visibilitychange',visibility);for(const value of tags.values())value.node.remove();tags.clear();}
  view.addEventListener('resize',refresh);document.addEventListener('visibilitychange',visibility);refresh();
  return {refresh,update,renderText,status:()=>({panels:[...tags.keys()]}),cleanup};
}
