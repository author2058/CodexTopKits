// Extract model-authored payloads from newly received events, not runtime envelopes.
export function appendLiveOutput(records, method, params) {
  const threadId = (params?.threadId || params?.thread?.id || '').split(':').at(-1);
  const streamedType = ({ 'item/agentMessage/delta': 'agentMessage', 'item/plan/delta': 'plan', 'item/reasoning/summaryTextDelta': 'summary' })[method];
  const snapshot = method === 'item/started' || method === 'item/completed';
  const inputEvent = ['item/fileChange/patchUpdated', 'turn/plan/updated', 'item/tool/requestUserInput', 'item/tool/call'].includes(method);
  if (!threadId || (!streamedType && !snapshot && !inputEvent && !['turn/started', 'turn/completed'].includes(method))) return false;
  const turnId = params?.turnId || params?.turn?.id || null;
  let record = records.get(threadId);
  if (method === 'turn/completed') {
    if (!record?.open || (turnId && record.turnId && turnId !== record.turnId)) return false;
    record.open = false;
    return true; // Hide on native completion, preserving the final output for reopening.
  }
  if (!record) {
    record = { turnId: null, text: '', streamKey: null, open: false, deltas: 0 };
    records.set(threadId, record);
  }
  if (method === 'turn/started') {
    if (record.turnId === turnId) return false;
    Object.assign(record, { turnId, text: '', streamKey: null, deltas: 0, seen: new Map(), entries: [], entrySequence: 0 });
    return true; // Refresh the cleared overlay without printing the lifecycle event.
  }
  // Do not append delayed deltas belonging to a different known turn.
  if (turnId && record.turnId && record.turnId !== turnId) return false;
  if (turnId) record.turnId = turnId;
  record.seen ??= new Map();
  record.entries ??= [];
  record.entrySequence ??= 0;
  const flatten = (text) => text.replace(/\r\n|\r|\n/g, ' ');
  const credentials = new Set(['accessToken', 'refreshToken', 'idToken', 'apiKey', 'authorization', 'cookie', 'password', 'actionToken', 'encryptedContent', 'encrypted_content']);
  const argumentText = (value) => typeof value === 'string' ? flatten(value) : JSON.stringify(value, (key, entry) => {
    if (credentials.has(key)) return '[omitted]';
    if (entry?.type === 'image' && typeof entry.data === 'string') return { type: 'image', mimeType: entry.mimeType };
    if (typeof entry === 'string' && entry.startsWith('data:image/')) return '[image]';
    if (typeof entry === 'string') return flatten(entry);
    return entry;
  });
  const chunks = [];
  const add = (key, text, tool = false) => chunks.push({ key, text: tool && typeof text === 'string' ? flatten(text) : text });
  // The native mapping defines add.diff as new content, delete.diff as old
  // content, and update.diff as unified_diff. Only new text is model-authored.
  const patch = (id, changes) => {
    for (const [index, change] of (changes || []).entries()) {
      if (typeof change.diff !== 'string') continue;
      const kind = change.kind?.type;
      if (kind === 'add') add('patch:' + id + ':' + index, change.diff, true);
      if (kind === 'update') {
        let inHunk = false;
        const added = [];
        for (const line of change.diff.split(/\r\n|\n|\r/)) {
          if (/^@@ /.test(line)) { inHunk = true; continue; }
          if (/^(?:diff --git |--- |\+\+\+ )/.test(line) && !inHunk) continue;
          if (inHunk && line.startsWith('+')) added.push(line.slice(1));
        }
        add('patch:' + id + ':' + index, added.join('\n'), true);
      }
    }
  };
  const questions = (id, entries) => {
    for (const [index, question] of (entries || []).entries()) {
      add('question:' + id + ':' + index, argumentText(question.question == null
        ? { title: question.title, options: question.options }
        : { header: question.header, question: question.question, options: question.options?.map(option => ({ label: option.label, description: option.description })) }));
    }
  };
  if (streamedType && typeof params.delta === 'string') {
    chunks.push({ key: streamedType + ':' + params.itemId + (streamedType === 'summary' ? ':' + (params.summaryIndex ?? 0) : ''), text: params.delta, streaming: true });
  } else if (method === 'item/fileChange/patchUpdated') {
    patch(params.itemId, params.changes);
  } else if (method === 'turn/plan/updated') {
    add('plan-input:' + turnId + ':explanation', params.explanation);
    for (const [index, step] of (params.plan || []).entries()) add('plan-input:' + turnId + ':' + index, step.step);
  } else if (method === 'item/tool/requestUserInput') {
    questions(params.itemId, params.questions);
  } else if (method === 'item/tool/call' && params.arguments != null) {
    add('tool:' + params.callId, argumentText(params.arguments));
  } else if (snapshot && params.item?.id) {
    const item = params.item;
    if (method === 'item/completed' && ['agentMessage', 'plan'].includes(item.type)) {
      chunks.push({ key: item.type + ':' + item.id, text: item.text });
      if (item.type === 'agentMessage') questions(item.id, item.questions);
    } else if (method === 'item/completed' && item.type === 'reasoning') {
      for (const [index, part] of (item.summary || []).entries()) {
        chunks.push({ key: 'summary:' + item.id + ':' + index, text: typeof part === 'string' ? part : part?.text });
      }
    } else if (['mcpToolCall', 'dynamicToolCall'].includes(item.type) && item.arguments != null) {
      chunks.push({ key: 'tool:' + item.id, text: argumentText(item.arguments) });
    } else if (['collabAgentToolCall', 'collabToolCall'].includes(item.type) && typeof item.prompt === 'string') {
      chunks.push({ key: 'tool:' + item.id, text: flatten(item.prompt) });
      if (item.model != null || item.reasoningEffort != null) add('tool-settings:' + item.id, argumentText({ model: item.model, reasoningEffort: item.reasoningEffort }));
    } else if (item.type === 'webSearch') {
      const action = item.action || {};
      const inputs = [...new Set([item.query, action.query, ...(action.queries || []), action.url, action.pattern].filter(value => typeof value === 'string' && value))];
      for (const [index, input] of inputs.entries()) add('search:' + item.id + ':' + index, input, true);
    } else if (item.type === 'commandExecution' && item.source !== 'userShell') {
      for (const [index, action] of (item.commandActions || []).entries()) add('command:' + item.id + ':' + index, action.command, true);
      // Native UI also falls back to command only when it is not a shell wrapper.
      if (!item.commandActions?.length && typeof item.command === 'string' && !/^(?:.*[/\\])?(?:bash|cmd(?:\.exe)?|fish|powershell(?:\.exe)?|pwsh(?:\.exe)?|sh|zsh)(?:\s|$)/i.test(item.command.trim())) add('command:' + item.id + ':0', item.command, true);
    } else if (item.type === 'fileChange') {
      patch(item.id, item.changes);
    } else if (item.type === 'imageView') {
      add('image-input:' + item.id, item.path, true);
    } else if (item.type === 'sleep' && typeof item.durationMs === 'number') {
      add('sleep-input:' + item.id, String(item.durationMs));
    }
    // User/hook input, function outputs, agent activity, compaction and image
    // result payloads are not conversation-model text. Review-mode strings have
    // no verified author provenance in this renderer protocol and are not guessed.
  }
  let changed = false;
  for (const { key, text, streaming } of chunks) {
    if (typeof text !== 'string' || !text) continue;
    const previous = record.seen.get(key);
    if (streaming && previous?.final) continue;
    let fresh = text;
    if (!streaming && previous) {
      if (text === previous.text || previous.text.startsWith(text)) {
        previous.final ||= method === 'item/completed';
        continue;
      }
      if (text.startsWith(previous.text)) fresh = text.slice(previous.text.length);
    }
    const separator = record.streamKey && record.streamKey !== key && record.text && !record.text.endsWith('\n') ? '\n' : '';
    fresh = fresh.replace(/\r\n/g, '\n');
    const last = record.entries.at(-1);
    if (last && record.streamKey === key) last.text += fresh;
    else record.entries.push({ id: ++record.entrySequence, prefix: separator, text: fresh });
    const full = record.text + separator + fresh;
    record.text = full.split('\n').slice(-50).join('\n');
    let dropped = full.length - record.text.length;
    while (dropped > 0 && record.entries.length) {
      const head = record.entries[0], length = head.prefix.length + head.text.length;
      if (dropped >= length) { record.entries.shift(); dropped -= length; }
      else {
        head.text = head.text.slice(Math.max(0, dropped - head.prefix.length));
        head.prefix = head.prefix.slice(dropped);
        dropped = 0;
      }
    }
    record.streamKey = key;
    record.seen.set(key, { text: streaming ? (previous?.text || '') + text : text, final: method === 'item/completed' });
    record.deltas += 1;
    changed = true;
  }
  return changed;
}

export function installLiveOutput(document, append, existing = null, labels = null) {
  const view = document.defaultView, records = existing?.records || new Map(), methods = existing?.methods || new Map(), itemTypes = existing?.itemTypes || new Map();
  const rendered = new WeakMap(), controls = new Map();
  const renderText = () => {
    const text = labels ? labels() : { title: '点击展开或关闭本线程模型输出（最新50行）', output: '本线程模型输出，最新50行' };
    for (const [bar, overlay] of controls) {
      if (bar.title !== text.title) bar.title = text.title;
      if (labels && bar.getAttribute('aria-label') !== text.title) bar.setAttribute('aria-label', text.title);
      if (overlay.getAttribute('aria-label') !== text.output) overlay.setAttribute('aria-label', text.output);
    }
  };
  let frame = null, stopped = false;
  const recordFor = (id) => {
    if (!records.has(id)) records.set(id, { turnId: null, text: '', streamKey: null, open: false, deltas: 0 });
    return records.get(id);
  };
  const render = () => {
    if (stopped) return;
    const retained = new Set(), retainedBars = new Set();
    for (const bar of document.querySelectorAll('.codex-composer-running-bar[data-cdt-live-thread-id]')) {
      const threadId = bar.dataset.cdtLiveThreadId;
      const record = recordFor(threadId);
      bar.removeAttribute('aria-hidden');
      bar.setAttribute('role', 'button');
      bar.setAttribute('tabindex', '0');
      if (bar.getAttribute('aria-expanded') !== String(record.open)) bar.setAttribute('aria-expanded', String(record.open));
      const host = bar.parentElement;
      let overlay = host.querySelector(':scope > .codex-live-output-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'codex-live-output-overlay';
        overlay.setAttribute('role', 'log');
        overlay.setAttribute('aria-live', 'off');
        overlay.setAttribute('tabindex', '0');
        host.append(overlay);
      }
      retained.add(overlay);
      retainedBars.add(bar);
      controls.set(bar, overlay);
      const wasHidden = overlay.hidden;
      const changedThread = overlay.dataset.threadId !== threadId;
      const follow = wasHidden || changedThread || Math.ceil(overlay.scrollTop + overlay.clientHeight) >= overlay.scrollHeight;
      overlay.dataset.threadId = threadId;
      if (overlay.hidden !== !record.open) overlay.hidden = !record.open;
      if (record.open) {
        let cached = rendered.get(overlay);
        if (!cached || cached.threadId !== threadId) {
          overlay.replaceChildren();
          cached = { threadId, rows: new Map() };
          rendered.set(overlay, cached);
        }
        const rows = cached.rows;
        const entries = record.entries || [], ids = new Set(entries.map(entry => entry.id));
        for (const [id, node] of rows) if (!ids.has(id)) { node.remove(); rows.delete(id); }
        for (const [index, entry] of entries.entries()) {
          let node = rows.get(entry.id);
          if (!node) {
            node = document.createElement('div');
            node.className = 'codex-live-output-entry' + (entry.id % 2 === 0 ? ' codex-live-output-entry-even' : '');
            node.dataset.entryId = String(entry.id);
            node.append(document.createTextNode(''));
            overlay.append(node);
            rows.set(entry.id, node);
          }
          const text = (index === 0 ? entry.prefix : '') + entry.text, leaf = node.firstChild;
          if (text !== leaf.data) {
            if (text.startsWith(leaf.data)) leaf.appendData(text.slice(leaf.data.length));
            else leaf.data = text;
          }
        }
      }
      if (follow && record.open) overlay.scrollTop = overlay.scrollHeight;
    }
    for (const bar of controls.keys()) if (!retainedBars.has(bar)) controls.delete(bar);
    for (const overlay of document.querySelectorAll('.codex-live-output-overlay')) if (!retained.has(overlay)) overlay.remove();
    renderText();
  };
  const refresh = () => {
    if (!stopped && frame === null) frame = view.requestAnimationFrame(() => { frame = null; render(); });
  };
  const activate = (event) => {
    const bar = event.target.closest?.('.codex-composer-running-bar[data-cdt-live-thread-id]');
    if (!bar || (event.type === 'keydown' && !['Enter', ' '].includes(event.key))) return;
    event.preventDefault();
    event.stopPropagation();
    const record = recordFor(bar.dataset.cdtLiveThreadId);
    record.open = !record.open;
    render();
  };
  document.addEventListener('click', activate);
  document.addEventListener('keydown', activate);
  refresh();
  return {
    refresh, renderText,
    receive(method, params) {
      if (append(records, method, params)) {
        methods.set(method, (methods.get(method) || 0) + 1);
        if (params.item?.type) itemTypes.set(params.item.type, (itemTypes.get(params.item.type) || 0) + 1);
        refresh();
      }
    },
    status: () => ({ installed: !stopped, threads: records.size, events: [...records.values()].reduce((n, r) => n + r.deltas, 0), methods: Object.fromEntries(methods), itemTypes: Object.fromEntries(itemTypes), overlays: document.querySelectorAll('.codex-live-output-overlay').length }),
    snapshot: () => ({ records, methods, itemTypes }),
    cleanup() {
      stopped = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      document.removeEventListener('click', activate);
      document.removeEventListener('keydown', activate);
      for (const overlay of document.querySelectorAll('.codex-live-output-overlay')) overlay.remove();
      controls.clear();
      for (const bar of document.querySelectorAll('.codex-composer-running-bar[data-cdt-live-thread-id]')) {
        bar.removeAttribute('role'); bar.removeAttribute('tabindex'); bar.removeAttribute('aria-expanded'); if (labels) bar.removeAttribute('aria-label'); bar.removeAttribute('title');
        bar.setAttribute('aria-hidden', 'true');
      }
    },
  };
}
