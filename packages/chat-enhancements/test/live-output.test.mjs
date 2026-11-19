import test from 'node:test';
import assert from 'node:assert/strict';
import { appendLiveOutput } from '../src/live-output.mjs';
import { chatCss, liveOutputCss } from '../src/styles.mjs';

const delta = (threadId, turnId, text, itemId = 'item') => ({ threadId, turnId, itemId, delta: text });

test('legacy CSS hands off only the live-output panel styling', () => {
  assert.equal(chatCss(false, ['live-model-output']), chatCss().replace(liveOutputCss(), ''));
});

test('live output keeps blue rows and readable text in both schemes', () => {
  const css = liveOutputCss();
  assert.match(css, /light-dark\(#dbeafe,#1056a8\)/);
  assert.match(css, /light-dark\(#bfdbfe,#0d4586\)/);
  assert.match(css, /color:light-dark\(#172f53,var\(--color-token-text-primary/);
  assert.match(css, /light-dark\(#4777a9,#8ab6e6\)/);
});

test('public chunks append as received and preserve whitespace and line breaks', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/reasoning/summaryTextDelta', delta('a', 'turn', 'Hello  '));
  appendLiveOutput(records, 'item/reasoning/summaryTextDelta', delta('a', 'turn', 'world\nnext'));
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'turn', 'Answer', 'answer'));
  assert.equal(records.get('a').text, 'Hello  world\nnext\nAnswer');
  assert.equal(records.get('a').deltas, 3);
});

test('retains latest 50 newline-delimited lines', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'turn', Array.from({ length: 70 }, (_, i) => String(i)).join('\n')));
  assert.equal(records.get('a').text.split('\n').length, 50);
  assert.equal(records.get('a').text.split('\n')[0], '20');
});

test('entries retain assigned parity when old rows expire and wrapped text stays one entry', () => {
  const records = new Map();
  for (let i = 0; i < 60; i++) appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'turn', 'text ' + i, 'item' + i));
  const record = records.get('a');
  assert.equal(record.entries.length, 50);
  assert.equal(record.entries[0].id, 11);
  const kept = record.entries.at(-1);
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'turn', ' more\nsecond line', 'item59'));
  assert.equal(record.entries.at(-1), kept);
  assert.equal(kept.id, 60);
  assert.equal(kept.text, 'text 59 more\nsecond line');
  assert.equal(record.entries.map(e => e.prefix + e.text).join(''), record.text);
  appendLiveOutput(records, 'turn/started', { threadId: 'a', turnId: 'next' });
  assert.deepEqual(record.entries, []);
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'next', 'new', 'new'));
  assert.equal(record.entries[0].id, 1);
});

test('partial trimming changes only entry text, not its identity or parity', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'turn', Array.from({ length: 52 }, (_, i) => String(i)).join('\n'), 'first'));
  const record = records.get('a'), first = record.entries[0];
  assert.equal(first.id, 1);
  assert.equal(first.text.split('\n')[0], '2');
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'turn', 'last', 'last'));
  assert.equal(record.entries[0], first);
  assert.equal(first.text.split('\n')[0], '3');
  assert.equal(record.entries.map(e => e.prefix + e.text).join(''), record.text);
});

test('receives while closed, isolates threads, keeps completion, clears at next turn', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'one', 'first'));
  appendLiveOutput(records, 'item/agentMessage/delta', delta('b', 'one', 'other'));
  assert.equal(records.get('a').open, false);
  appendLiveOutput(records, 'turn/completed', { threadId: 'a', turnId: 'one' });
  assert.equal(records.get('a').text, 'first');
  records.get('a').open = true;
  appendLiveOutput(records, 'turn/started', { threadId: 'a', turn: { id: 'two' } });
  assert.equal(records.get('a').text, '');
  assert.equal(records.get('a').open, true);
  assert.equal(records.get('b').text, 'other');
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'two', 'fresh'));
  appendLiveOutput(records, 'turn/started', { threadId: 'a', turnId: 'two' });
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'one', 'late old data'));
  assert.ok(records.get('a').text.endsWith('fresh'));
  assert.ok(!records.get('a').text.includes('late old data'));
});

test('prints arguments only, never tool results or runtime envelopes', () => {
  const records = new Map();
  const item = { id: 'tool', type: 'mcpToolCall', tool: 'search', arguments: { query: 'hello' }, status: 'inProgress', durationMs: 9999 };
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item, timestamp: '2099-01-01T00:00:00.123456789Z' });
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item: { ...item, result: 'RESULT_MUST_NOT_APPEAR' } });
  appendLiveOutput(records, 'item/commandExecution/outputDelta', delta('a', 'one', 'OUTPUT_MUST_NOT_APPEAR', 'exec'));
  appendLiveOutput(records, 'thread/status/changed', { threadId: 'a', status: { type: 'idle' } });
  appendLiveOutput(records, 'hook/completed', { threadId: 'a', output: 'HOOK_MUST_NOT_APPEAR' });
  assert.equal(records.get('a').text, '{"query":"hello"}');
});

test('native turn completion hides only its open overlay and keeps captured output', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'one', 'answer'));
  appendLiveOutput(records, 'item/agentMessage/delta', delta('b', 'other', 'other answer'));
  const a = records.get('a'), b = records.get('b');
  a.open = b.open = true;
  assert.equal(appendLiveOutput(records, 'turn/completed', { threadId:'a', turnId:'old' }),false);
  assert.equal(a.open,true);
  assert.equal(appendLiveOutput(records, 'turn/completed', { threadId:'a', turn:{id:'one',status:'completed'} }),true);
  assert.equal(a.open,false); assert.equal(a.text,'answer'); assert.equal(b.open,true);
  assert.equal(appendLiveOutput(records, 'turn/completed', { threadId:'a', turnId:'one' }),false);
  assert.equal(appendLiveOutput(records, 'turn/completed', { threadId:'unknown', turnId:'unknown' }),false);
  assert.equal(records.has('unknown'),false);
});

test('flattens tool arguments, deduplicates snapshots by ID, keeps distinct calls', () => {
  const records = new Map();
  const item = { id: 'tool1', type: 'dynamicToolCall', arguments: 'line1\r\nline2\nline3' };
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item });
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item });
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { ...item, id: 'tool2' } });
  assert.equal(records.get('a').text, 'line1 line2 line3\nline1 line2 line3');
});

test('does not read private reasoning or expose credential and image payloads', () => {
  const records = new Map();
  assert.equal(appendLiveOutput(records, 'item/reasoning/textDelta', delta('a', 'one', 'private')), false);
  const item = { id: 'reasoning', type: 'reasoning', summary: ['public summary'] };
  Object.defineProperty(item, 'content', { enumerable: true, get() { throw new Error('Private content must not be read'); } });
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item, accessToken: 'secret', image: 'data:image/png;base64,secret' });
  assert.equal(records.get('a').text, 'public summary');
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { type: 'mcpToolCall', id: 'tool', arguments: { query: 'hello', accessToken: 'secret', image: 'data:image/png;base64,secret' } } });
  assert.ok(!records.get('a').text.includes('secret'));
});

test('completed messages and summaries do not repeat streamed content', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/reasoning/summaryTextDelta', delta('a', 'one', 'summary', 'r'));
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item: { id: 'r', type: 'reasoning', summary: ['summary'] } });
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'one', 'answer', 'answer'));
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item: { id: 'answer', type: 'agentMessage', text: 'answer' } });
  appendLiveOutput(records, 'turn/completed', { threadId: 'a', turn: { id: 'one', items: [{ type: 'agentMessage', id: 'answer', text: 'answer' }], status: 'completed' } });
  assert.equal(records.get('a').text, 'summary\nanswer');
});

test('does not guess missing command bodies or accept invalid diffs', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { type: 'fileChange', id: 'patch', changes: [{ path: 'file.mjs', kind: 'update', diff: '+code' }] } });
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { type: 'commandExecution', id: 'exec', command: 'pwsh.exe -Command model_command', aggregatedOutput: 'result' } });
  assert.equal(records.get('a').text, '');
});

test('extracts all command action bodies, not wrappers, user shell or execution output', () => {
  const records = new Map();
  const item = { type: 'commandExecution', id: 'cmd', source: 'agent', command: 'pwsh.exe -Command WRAPPER', commandActions: [{ command: 'Get-Content "file.txt"' }, { command: 'second\nscript' }], aggregatedOutput: 'STDOUT', durationMs: 8765 };
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item });
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item });
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { ...item, id: 'user', source: 'userShell' } });
  assert.equal(records.get('a').text, 'Get-Content "file.txt"\nsecond script');
});

test('file changes include new text only and deduplicate patch updates', () => {
  const records = new Map();
  const changes = [
    { path: 'add', kind: { type: 'add' }, diff: 'entire\nnew file' },
    { path: 'update', kind: { type: 'update' }, diff: '--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n-old\n context\n+new code\n@@ -8 +8 @@\n++plus code' },
    { path: 'delete', kind: { type: 'delete' }, diff: 'OLD_FILE' },
  ];
  appendLiveOutput(records, 'item/fileChange/patchUpdated', { threadId: 'a', turnId: 'one', itemId: 'patch', changes });
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item: { id: 'patch', type: 'fileChange', changes } });
  assert.equal(records.get('a').text, 'entire new file\nnew code +plus code');
});

test('completion includes unseen streamed suffix and changed snapshots are not dropped', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'one', 'first', 'answer'));
  const item = { id: 'answer', type: 'agentMessage', text: 'first rest' };
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item });
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item });
  assert.equal(records.get('a').text, 'first rest');
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { id: 'tool', type: 'dynamicToolCall', arguments: 'initial' } });
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item: { id: 'tool', type: 'dynamicToolCall', arguments: 'initial added' } });
  assert.equal(records.get('a').text, 'first rest\ninitial added');
});

test('extracts actual native collab type, search actions and model plan text', () => {
  const records = new Map();
  const receive = item => appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item });
  receive({ id: 'child', type: 'collabAgentToolCall', prompt: 'child task', model: 'luna', reasoningEffort: 'high', agentsStates: { secret: 'running' } });
  receive({ id: 'search', type: 'webSearch', query: 'q1', action: { type: 'search', queries: ['q1', 'q2'] }, results: ['RESULT'] });
  receive({ id: 'find', type: 'webSearch', action: { type: 'findInPage', url: 'https://example.com', pattern: 'needle' } });
  appendLiveOutput(records, 'turn/plan/updated', { threadId: 'a', turnId: 'one', explanation: 'why', plan: [{ step: 'do it', status: 'in_progress' }] });
  appendLiveOutput(records, 'turn/plan/updated', { threadId: 'a', turnId: 'one', explanation: 'why', plan: [{ step: 'do it', status: 'completed' }] });
  assert.equal(records.get('a').text, 'child task\n{"model":"luna","reasoningEffort":"high"}\nq1\nq2\nhttps://example.com\nneedle\nwhy\ndo it');
});

test('server requests include model questions and arguments without answers or request metadata', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/tool/requestUserInput', { threadId: 'a', turnId: 'one', itemId: 'q', isBlocking: true, questions: [{ id: 'id', header: 'Choice', question: 'Which?', options: [{ label: 'A', description: 'option A' }], isSecret: false }] });
  appendLiveOutput(records, 'item/tool/call', { threadId: 'a', turnId: 'one', callId: 'tool', tool: 'exec', arguments: { cmd: 'echo hello' } });
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { id: 'tool', type: 'dynamicToolCall', arguments: { cmd: 'echo hello' }, contentItems: ['OUTPUT'] } });
  assert.equal(records.get('a').text, '{"header":"Choice","question":"Which?","options":[{"label":"A","description":"option A"}]}\n{"cmd":"echo hello"}');
});

test('classifies every current ThreadItem type without reading tool results or private fields', () => {
  const records = new Map();
  for (const type of ['userMessage', 'hookPrompt', 'functionCallOutput', 'subAgentActivity', 'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction']) {
    const item = { id: type, type };
    for (const field of ['content', 'output', 'result', 'review', 'revisedPrompt', 'encrypted_content']) Object.defineProperty(item, field, { get() { throw new Error('Excluded field was read: ' + field); } });
    appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item });
  }
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { type: 'imageView', id: 'image', path: '/selected.png' } });
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { type: 'sleep', id: 'sleep', durationMs: 1000 } });
  assert.equal(records.get('a').text, '/selected.png\n1000');
});

test('file update context and removed text never masquerade as new code', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/fileChange/patchUpdated', { threadId: 'a', turnId: 'one', itemId: 'patch', changes: [{ kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-removed code\n context only' }] });
  assert.equal(records.get('a').text, '');
});

test('newly received completion text is displayed once when no delta was received', () => {
  const records = new Map();
  const item = { type: 'agentMessage', id: 'answer', text: 'line1\nline2' };
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item });
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item });
  appendLiveOutput(records, 'item/agentMessage/delta', delta('a', 'one', 'late duplicate', 'answer'));
  assert.equal(records.get('a').text, 'line1\nline2');
});

test('includes public plan text, search queries and delegated prompts without metadata', () => {
  const records = new Map();
  appendLiveOutput(records, 'item/plan/delta', delta('a', 'one', 'plan', 'plan'));
  appendLiveOutput(records, 'item/completed', { threadId: 'a', turnId: 'one', item: { type: 'plan', id: 'plan', text: 'plan' } });
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { type: 'webSearch', id: 'search', query: 'question', results: ['result'] } });
  appendLiveOutput(records, 'item/started', { threadId: 'a', turnId: 'one', item: { type: 'collabToolCall', id: 'child', prompt: 'do\ntask', agentStatus: { child: 'running' } } });
  assert.equal(records.get('a').text, 'plan\nquestion\ndo task');
});
