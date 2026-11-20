export function createRoleModelSelection(context, helpers) {
  const { document, getRuntimeState, onRuntimeState, onDomChange, dispatch, reportError, i18n } = context;
  const { findRoleModelAnchor, readRoleModelControl, applyRoleModelControl, readNativeConversationIdentity, createNativeBridgeClient } = helpers;
  const view = document.defaultView, rows = new Map(), bridge = createNativeBridgeClient(view);
  const messages = {
    en: { unassigned: 'Unassigned', role: 'Role', settings: 'Role settings…', title: 'Role models', close: 'Close', save: 'Save', add: 'Add role', remove: 'Remove', refresh: 'Refresh recommendations', name: 'Name', family: 'Model family', unused: 'Exclude unused candidates', mean: 'Require a score above the model mean', excluded: 'Excluded efforts (comma-separated)', gain: 'Minimum intelligence gain (%)', speed: 'Minimum relative solve speed (%)', waiting: 'Applies after the current turn', loading: 'Loading recommendations', actual: 'Recommended models', unavailable: 'Recommendation unavailable', saved: 'Saved', pending: 'Applying role settings', failed: 'Role settings could not be applied' },
    'zh-Hans': { unassigned: '未指定', role: '角色', settings: '角色设置…', title: '角色模型', close: '关闭', save: '保存', add: '添加角色', remove: '移除', refresh: '刷新推荐', name: '名称', family: '模型家族', unused: '排除无人使用的候选', mean: '得分须高于本模型均值', excluded: '排除的思考等级（逗号分隔）', gain: '最低智力提升（%）', speed: '最低相对解题速度（%）', waiting: '本轮结束后应用', loading: '正在读取推荐', actual: '推荐模型', unavailable: '暂无推荐', saved: '已保存', pending: '正在应用角色配置', failed: '角色配置未能应用' },
  };
  const t = key => i18n.t(messages, key);
  messages.en.majority='Prefer a non-ultra effort used by more than 50% of the selected version’s requests';
  messages['zh-Hans'].majority='优先采用所选版本中请求占比超过 50% 的非 ultra 档';
  const state = () => getRuntimeState()?.roleModels;
  const key = (hostId, threadId) => JSON.stringify([hostId, threadId]);
  let stopped = false, queued = false, dialog, status, action, lastReceipt, working = new Set();
  const style = document.createElement('style'); style.setAttribute('data-cdtk-owned', 'role-model-selection');
  style.textContent = `
    .cdtk-role-picker{appearance:base-select;field-sizing:content;display:flex;align-items:center;font:inherit;font-size:var(--text-sm,13px);line-height:18px;color:var(--app-color-text-foreground-tertiary,GrayText);background:transparent;border:1px solid transparent;border-radius:9999px;padding:0 calc(var(--spacing,.25rem)*2);gap:4px;max-width:16em;min-width:0;height:var(--height-button-composer,28px);cursor:pointer;flex:0 1 auto}
    .cdtk-role-picker::picker-icon,.cdtk-role-settings td>select::picker-icon{content:"";flex:none;width:16px;height:16px;margin:0;background:currentColor;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M10.2954 6.54537C10.5003 6.3404 10.8325 6.34051 11.0376 6.54537C11.2426 6.7504 11.2426 7.08253 11.0376 7.28756L8.60689 9.71822C8.27169 10.0534 7.72823 10.0534 7.39303 9.71822L4.96236 7.28756C4.75734 7.08253 4.75734 6.7504 4.96236 6.54537C5.16739 6.34035 5.49952 6.34035 5.70455 6.54537L7.99947 8.84029L10.2954 6.54537Z'/%3E%3C/svg%3E") center/contain no-repeat;forced-color-adjust:none}
    .cdtk-role-picker:is(:hover,:open):not(:disabled){background:var(--color-background-secondary-ghost-hover,transparent)}
    .cdtk-role-picker:focus,.cdtk-role-settings td>select:focus{outline:none}
    .cdtk-role-picker:focus-visible,.cdtk-role-settings td>select:focus-visible{box-shadow:0 0 0 2px var(--color-ring,Highlight)}
    @media (forced-colors:active){.cdtk-role-picker:focus-visible,.cdtk-role-settings td>select:focus-visible{outline:2px solid Highlight}}
    .cdtk-role-picker:disabled{opacity:.4;cursor:default}
    .cdtk-role-picker[data-compact=true]{max-width:7em}
    .cdtk-role-picker::picker(select),.cdtk-role-settings tbody select::picker(select){appearance:base-select;box-sizing:border-box;inline-size:max-content;min-inline-size:anchor-size(width);max-inline-size:calc(100vw - 16px);margin-block:4px;padding:var(--spacing,.25rem);overflow:auto}
    .cdtk-role-picker option,.cdtk-role-settings option{padding:4px 8px;border-radius:var(--radius-md,8px);white-space:normal;overflow-wrap:anywhere}
    .cdtk-role-picker option:is(:hover,:focus-visible),.cdtk-role-settings option:is(:hover,:focus-visible){background:var(--color-background-secondary-ghost-hover,transparent)}
    .cdtk-role-picker::picker(select),.cdtk-role-settings tbody select::picker(select),.cdtk-role-settings{color:var(--app-color-text-foreground,CanvasText);background:color-mix(in oklab,var(--color-surface-elevated-secondary,Canvas) 90%,transparent);border:0;border-radius:var(--radius-2xl,16px);box-shadow:0 0 0 var(--dropdown-overlay-ring-width,.5px) var(--color-border-overlay,transparent),var(--shadow-dropdown-overlay,0 8px 16px -4px #0002);backdrop-filter:blur(4px)}
    .cdtk-role-settings{position:fixed;inset:0;margin:auto;box-sizing:border-box;width:620px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;padding:calc(var(--spacing,.25rem)*4);border-radius:var(--radius-2xl,16px);font:inherit}
    .cdtk-role-settings::backdrop{background:#0006}
    .cdtk-role-settings header{display:flex;align-items:center;justify-content:space-between}
    .cdtk-role-settings h2{font-size:1.15em;margin:0}
    .cdtk-role-settings table{width:100%;margin:8px 0;border-collapse:separate;border-spacing:4px 6px}
    .cdtk-role-settings td,.cdtk-role-settings th{padding:0}
    .cdtk-role-settings input,.cdtk-role-settings select,.cdtk-role-settings button{font:inherit;color:inherit;background:var(--color-token-main-surface-secondary,light-dark(#eef1f5,#252d39));border:1px solid var(--color-token-border-light,light-dark(#c8cfd9,#4d5868));border-radius:var(--radius-lg,8px);padding:4px 8px}
    .cdtk-role-settings input[type=text],.cdtk-role-settings td>select,.cdtk-role-settings td>button{width:100%;box-sizing:border-box}
    .cdtk-role-settings td>select{appearance:base-select;display:flex;align-items:center;gap:4px}
    .cdtk-role-settings label{display:flex;gap:8px;align-items:center;margin:8px 0}
    .cdtk-role-settings input[type=number]{width:5em}
    .cdtk-role-settings footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
    .cdtk-role-settings [role=status]{white-space:pre-wrap;margin-top:10px}
    .cdtk-role-settings [data-error=true]{color:light-dark(#b42318,#ff8b8b)}
  `;
  document.head.appendChild(style);
  const element = (tag, text, parent) => { const node = document.createElement(tag); if (text != null) node.textContent = text; parent?.appendChild(node); return node; };
  const send = (operation, value) => {
    if (action) return;
    action = { requestId: view.crypto.randomUUID(), operation };
    try { dispatch({ kind: 'role-model-action', ...action, value }); }
    catch (error) { action = null; throw error; }
    refresh();
  };
  const showStatus = (text, error = false) => { if (status) { status.textContent = text; status.dataset.error = String(error); } };
  const closeSettings = () => { dialog?.remove(); dialog = null; status = null; };
  const openSettings = () => {
    if (dialog || !state()) return;
    const policy = structuredClone(state().policy);
    dialog = element('dialog'); dialog.className = 'cdtk-role-settings'; dialog.setAttribute('data-cdtk-owned', 'role-model-selection');
    const ownedDialog=dialog;
    ownedDialog.addEventListener('cancel',event=>{event.preventDefault();if(dialog===ownedDialog)closeSettings();});
    ownedDialog.addEventListener('close',()=>{if(dialog===ownedDialog)closeSettings();});
    const header = element('header', null, dialog); element('h2', t('title'), header);
    const close = element('button', t('close'), header); close.type = 'button'; close.onclick = closeSettings;
    const table = element('table', null, dialog), heading = element('tr', null, element('thead', null, table));
    for (const value of [t('name'), t('family'), '']) element('th', value, heading);
    const body = element('tbody', null, table), entries = [];
    const add = role => {
      const tr = element('tr', null, body), name = element('input', null, element('td', null, tr)); name.type = 'text'; name.value = role.name; name.setAttribute('aria-label', t('name'));
      const family = element('select', null, element('td', null, tr)); family.setAttribute('aria-label', t('family'));
      for (const value of ['sol', 'terra', 'astra', 'luna']) { const option = element('option', value, family); option.value = value; } family.value = role.family;
      const remove = element('button', t('remove'), element('td', null, tr)); remove.type = 'button'; remove.onclick = () => { tr.remove(); entries.splice(entries.indexOf(entry), 1); };
      const entry = { role, name, family }; entries.push(entry);
    };
    policy.roles.forEach(add);
    const addButton = element('button', t('add'), dialog); addButton.type = 'button'; addButton.onclick = () => add({ id: view.crypto.randomUUID(), name: 'New role', family: 'sol' });
    const fields = {};
    for (const [id, label, type, value] of [['preferMajorityEffort','majority','checkbox',policy.selection.preferMajorityEffort],['excludeUnused','unused','checkbox',policy.selection.excludeUnused],['aboveMean','mean','checkbox',policy.selection.aboveMean],['excludedEfforts','excluded','text',policy.selection.excludedEfforts.join(', ')],['minIntelligenceGainPercent','gain','number',policy.selection.minIntelligenceGainPercent],['minSpeedPercent','speed','number',policy.selection.minSpeedPercent]]) {
      const wrapper = element('label', null, dialog), input = element('input', null, wrapper); input.type = type;
      if (type === 'checkbox') input.checked = value; else input.value = value;
      if (type === 'number') { input.min = '0'; input.step = 'any'; }
      element('span', t(label), wrapper); fields[id] = input;
    }
    element('h3', t('actual'), dialog);
    for (const family of ['sol','terra','astra','luna']) { const result = state().recommendations?.selections?.[family]?.selected; element('div', family + ': ' + (result ? result.model + ' / ' + result.effort : t('unavailable')), dialog); }
    const footer = element('footer', null, dialog), save = element('button', t('save'), footer), update = element('button', t('refresh'), footer);
    save.type = update.type = 'button'; status = element('div', '', dialog); status.setAttribute('role','status');
    save.onclick = () => {
      try { send('policy', { ...policy, roles: entries.map(({role,name,family}) => ({ id:role.id, name:name.value.trim(), family:family.value })), selection: { preferMajorityEffort:fields.preferMajorityEffort.checked, excludeUnused:fields.excludeUnused.checked, aboveMean:fields.aboveMean.checked, excludedEfforts:fields.excludedEfforts.value.split(',').map(s=>s.trim()).filter(Boolean), minIntelligenceGainPercent:Number(fields.minIntelligenceGainPercent.value), minSpeedPercent:Number(fields.minSpeedPercent.value) } }); }
      catch (error) { showStatus(error.message, true); reportError(error, 'settings'); }
    };
    update.onclick = () => { try { send('refresh'); showStatus(t('loading')); } catch (error) { showStatus(error.message,true); reportError(error,'settings'); } };
    document.body.appendChild(dialog); dialog.showModal();
  };
  const identity = row => {
    let native;
    try { native = readRoleModelControl(row.anchor.model); } catch (error) { row.nativeError = error; }
    const panel = row.root.closest('[role="tabpanel"][data-tab-id]'), current = readNativeConversationIdentity(document);
    const threadId = native ? native.threadId : (panel ? panel.getAttribute('data-tab-id').split(':').slice(1).join(':').replace(/^local:/,'') : current?.taskKey?.replace(/^local:/,''));
    return { native, threadId: threadId || null, hostId: native?.hostId || current?.hostId || 'local' };
  };
  const apply = (row, role, desired, current) => {
    if (row.pending || row.failed === role.id + ':' + desired.model + ':' + desired.effort) return;
    const generation=row.generation;
    const owns=()=>!stopped&&rows.get(row.root)===row&&row.generation===generation;
    const work = (async () => {
      if (!current.native) throw row.nativeError;
      if (current.threadId) {
        const result = await bridge.appServer('thread/read', { threadId:current.threadId, includeTurns:false }, { hostId:current.hostId, source:'codextopkits_role_read' });
        if(!owns())return;
        if (result.thread?.id !== current.threadId) throw new Error('Role model thread identity changed.');
        if (result.thread.status?.type === 'active') { row.waiting = true; return; }
      }
      if (!owns() || !row.root.isConnected || row.roleId !== role.id) return;
      const latest = identity(row);
      if (latest.threadId !== current.threadId || latest.hostId !== current.hostId) return;
      await applyRoleModelControl(latest.native, desired);
      await new Promise(resolve => { const channel=new view.MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null); });
      if (!owns() || !row.root.isConnected) return;
      const after = identity(row);
      if (after.threadId !== current.threadId || after.hostId !== current.hostId) return;
      if (after.native?.api.modelSettings.model !== desired.model || after.native?.api.modelSettings.reasoningEffort !== desired.effort) throw new Error('Native composer model readback did not match the role recommendation.');
      if (current.threadId) {
        const actual = await bridge.appServer('thread/resume', { threadId:current.threadId, excludeTurns:true }, { hostId:current.hostId, source:'codextopkits_role_verify' });
        if(!owns())return;
        if (actual.model !== desired.model || (actual.reasoningEffort ?? actual.effort) !== desired.effort) throw new Error('Native thread model readback did not match the role recommendation.');
      }
      row.applied = desired.model + '/' + desired.effort; row.waiting = false; row.failed = null; reportError(null,'model:' + row.id);
    })().catch(error => { if (owns()) { row.failed = role.id + ':' + desired.model + ':' + desired.effort; row.select.title = error.message; reportError(error,'model:' + row.id); } }).finally(() => { if(row.pending===work)row.pending=null;working.delete(work);schedule(); });
    row.pending = work; working.add(work);
  };
  function refresh() {
    if (stopped) return;
    const snapshot = state();
    if (snapshot?.receipt && snapshot.receipt.requestId !== lastReceipt) {
      lastReceipt = snapshot.receipt.requestId;
      if (action?.requestId === lastReceipt) { action = null; showStatus(snapshot.receipt.ok ? t('saved') : snapshot.receipt.message,!snapshot.receipt.ok); }
    }
    const roots = new Set([...document.querySelectorAll('[class*="ComposerLayoutRoot"],[data-codex-composer-root]')].filter(root => root.querySelector('[contenteditable="true"],textarea') && root.getClientRects().length && !root.parentElement?.closest('[class*="ComposerLayoutRoot"],[data-codex-composer-root]')));
    for (const [root,row] of rows) if (!roots.has(root)) { row.select.remove();row.removeSubmit();row.resize?.disconnect();reportError(null,'model:' + row.id);rows.delete(root); }
    for (const root of roots) {
      const anchor = findRoleModelAnchor(root); if (!anchor) continue;
      let row = rows.get(root);
      if (!row) {
        const select = element('select'); select.className = 'cdtk-role-picker'; select.setAttribute('data-cdtk-owned','role-model-selection');
        row = { root, select, anchor, id:view.crypto.randomUUID(), draftRole:'', pending:null,generation:0,createdThreads:new Set() }; rows.set(root,row);
        const submitted=event=>{
          if(!row.draftRole||row.threadKey)return;
          if(event.type==='submit'||event.type==='keydown'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.target.closest('[contenteditable="true"],textarea')||event.type==='click'&&event.target.closest('button[type="submit"],button[data-testid="send-button"],button[aria-label="Send"],button[aria-label="Send message"],button[aria-label="发送"],button[aria-label="发送消息"]'))row.submitted=true;
        };
        for(const type of ['keydown','submit','click'])root.addEventListener(type,submitted,true);
        row.removeSubmit=()=>{for(const type of ['keydown','submit','click'])root.removeEventListener(type,submitted,true);};
        select.onblur = schedule;
        select.onchange = () => {
          if (select.value === '__settings__') { select.value = row.roleId || ''; openSettings(); return; }
          const value = select.value, current = identity(row); row.failed = null;
          if (current.threadId) send('assign', { hostId:current.hostId, threadId:current.threadId, roleId:value });
          else {row.draftRole=value;row.submitted=false;row.createdThreads.clear();}
          schedule();
        };
        if (view.ResizeObserver) { row.resize = new view.ResizeObserver(entries => { const compact = entries[0].contentRect.width < 480; if (select.dataset.compact !== String(compact)) select.dataset.compact = String(compact); }); row.resize.observe(root); }
      }
      row.anchor = anchor;
      if (row.select.parentElement !== anchor.parent || row.select.nextSibling !== anchor.before) anchor.parent.insertBefore(row.select,anchor.before);
      if (!snapshot) { row.select.disabled = true; continue; }
      const signature = JSON.stringify([i18n.locale,snapshot.policy.roles]);
      if (row.options !== signature && document.activeElement !== row.select) {
        row.select.replaceChildren(); const empty = element('option',t('unassigned'),row.select); empty.value = '';
        for (const role of snapshot.policy.roles) { const option=element('option',role.name,row.select); option.value=role.id; }
        const settings=element('option',t('settings'),row.select);settings.value='__settings__'; row.options=signature;
      }
      const current = identity(row), threadKey = current.threadId ? key(current.hostId,current.threadId) : null;
      if (row.threadKey !== threadKey) {
        const draftRole=row.draftRole,created=threadKey&&row.submitted&&row.createdThreads.has(current.threadId);
        row.threadKey=threadKey;row.generation++;row.applied=null;row.waiting=false;row.failed=null;row.draftRole='';row.submitted=false;row.createdThreads.clear();
        if(draftRole&&created&&!action){send('assign',{hostId:current.hostId,threadId:current.threadId,roleId:draftRole});continue;}
      }
      row.roleId = threadKey ? snapshot.assignments[threadKey] || '' : row.draftRole;
      if (!row.roleId) { row.failed=null;row.applied=null;reportError(null,'model:'+row.id); }
      if (row.applied && !row.pending && !action && current.native && row.applied !== current.native.api.modelSettings.model+'/'+current.native.api.modelSettings.reasoningEffort) {
        row.applied=null;
        if (threadKey) send('assign',{hostId:current.hostId,threadId:current.threadId,roleId:''}); else row.draftRole='';
        continue;
      }
      if (row.select.value !== row.roleId) row.select.value = row.roleId;
      row.select.disabled = Boolean(action || row.pending);
      row.select.setAttribute('aria-label',t('role')); row.select.title = row.pending ? t('pending') : row.waiting ? t('waiting') : snapshot.error || t('role');
      const role = snapshot.policy.roles.find(role=>role.id===row.roleId), desired = role && snapshot.recommendations?.selections?.[role.family]?.selected;
      const operationKey=row.roleId+':'+(desired?desired.model+'/'+desired.effort:'');
      if(row.operationKey!==operationKey){row.operationKey=operationKey;row.generation++;}
      if (role && desired && current.native && !row.applied && current.native.api.modelSettings.model===desired.model && current.native.api.modelSettings.reasoningEffort===desired.effort) row.applied=desired.model+'/'+desired.effort;
      if (role && desired && snapshot.recommendationsValidated && !row.waiting && row.applied !== desired.model+'/'+desired.effort) apply(row,role,desired,current);
    }
  }
  function schedule() { if (!queued && !stopped) { queued=true; view.queueMicrotask(()=>{queued=false;try{refresh();}catch(error){reportError(error,'renderer');}}); } }
  const receive = event => {
    if (event.source && event.source!==view || event.data?.type!=='mcp-notification')return;
    const note=event.data.notification??event.data;
    if(note.method==='thread/started')for(const row of rows.values())if(row.draftRole&&row.submitted&&!row.threadKey&&(!event.data.hostId||event.data.hostId===identity(row).hostId)){const id=note.params?.thread?.id||note.params?.threadId;if(id)row.createdThreads.add(id);}
    if (['turn/completed','thread/status/changed','thread/resumed','thread/settings/updated','thread/started'].includes(note.method)) { for(const row of rows.values())row.waiting=false; schedule(); }
  };
  const unsubscribeDom=onDomChange(schedule), unsubscribeState=onRuntimeState(schedule), unsubscribeLocale=i18n.onChange(schedule);
  view.addEventListener('message',receive);
  try { refresh(); } catch(error) { unsubscribeDom();unsubscribeState();unsubscribeLocale();bridge.close();style.remove();throw error; }
  return { refresh:schedule, beforeRestart(){if(working.size)throw new Error('Wait for the role model settings update to finish.');}, async close(){stopped=true;unsubscribeDom();unsubscribeState();unsubscribeLocale();view.removeEventListener('message',receive);await Promise.all([...working]);bridge.close();for(const row of rows.values()){row.removeSubmit();row.resize?.disconnect();row.select.remove();}rows.clear();closeSettings();style.remove();} };
}
