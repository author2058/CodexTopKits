import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { kitModule } from 'codex-toolkit-core/kits';
import kitRuntime from 'codex-toolkit-core/kit-runtime';
import kit from '../kits/message-labels/index.mjs';
import { readMessageLabelIndex } from '../src/message-label-history.mjs';
import createChatHistoryService from '../src/history-service.mjs';

test('native metadata covers the whole turn across a resumed thread alias, excluding tools and empty text', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-message-label-test-'));
  const dbPath = path.join(directory, 'thread_history_1.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT, final_agent_item_id TEXT);
      CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, item_type TEXT, rollout_ordinal INTEGER,
        item_json TEXT, completed_at_ms INTEGER, started_at_ms INTEGER, created_at_ms INTEGER);`);
    db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?)').run('resumed-alias', 'turn', 'completed', 'm54');
    const insert = db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?,?)');
    insert.run('resumed-alias', 'turn', 'tool', 'commandExecution', 0, JSON.stringify({ text: 'not a dialogue output' }), 5, 2, 1);
    insert.run('resumed-alias', 'turn', 'empty', 'agentMessage', 1, JSON.stringify({ text: ' \n\t' }), 5, 2, 1);
    for (let i = 1; i <= 54; i++) insert.run('resumed-alias', 'turn', 'm' + i, 'agentMessage', i + 1, JSON.stringify({ text: 'reply', phase: i === 54 ? 'final_answer' : 'commentary' }), 1000 + i, 100, 90);
    db.close();
    const result = await readMessageLabelIndex({ threadId: 'stable-ui-id', turnId: 'turn', anchorItemId: 'm54' }, { dbPath });
    assert.equal(result.threadId, 'stable-ui-id');
    assert.equal(result.messages.length, 54);
    assert.deepEqual(result.messages[0], { itemId: 'm1', ordinal: 1, timestamp: 1001 });
    assert.deepEqual(result.messages.at(-1), { itemId: 'm54', ordinal: 54, timestamp: 1054 });
    assert.equal('text' in result.messages[0], false);
    const resumed = new DatabaseSync(dbPath);
    resumed.prepare('UPDATE thread_turns SET status = ? WHERE turn_id = ?').run('inProgress', 'turn');
    resumed.close();
    const interrupted = await readMessageLabelIndex({ threadId: 'stable-ui-id', turnId: 'turn', anchorItemId: 'm54' }, { dbPath });
    assert.deepEqual(interrupted.messages, result.messages, 'a stale disk status must not reject the interrupted UI turn');
    await assert.rejects(readMessageLabelIndex({ threadId: 'stable-ui-id', turnId: 'turn', anchorItemId: 'wrong-message' }, { dbPath }), /no matching turn and anchor/);
    let reply;
    const service = await createChatHistoryService({ codexHome: directory }, { evaluatePage: async (targetId, expression) => {
      assert.equal(targetId, 'page');
      vm.runInNewContext(expression, { window: { __CODEXTOPKITS_MESSAGE_LABELS__: { resolve: (...args) => { reply = args; } } } });
    } });
    assert.equal(await service.receive('page', { kind: 'other' }), false);
    assert.equal(await service.receive('page', { kind: 'history-index', requestId: 'one', threadId: 'stable-ui-id', turnId: 'turn', anchorItemId: 'm54' }), true);
    assert.equal(reply[0], 'one'); assert.equal(reply[1].messages.length, 54); assert.equal(reply[1].messages.at(-1).ordinal, 54); assert.equal(reply[2], null);
    assert.equal('text' in reply[1].messages[0], false);
    await service.receive('page', { kind: 'history-index', requestId: 'two', threadId: 'stable-ui-id', turnId: 'turn', anchorItemId: 'wrong-message' });
    assert.equal(reply[0], 'two'); assert.equal(reply[1], null); assert.match(reply[2].message, /no matching turn and anchor/);
    service.close();

    const artifact = path.join(directory, 'artifact'), stateDirectory = path.join(directory, 'state');
    fs.mkdirSync(artifact); fs.mkdirSync(stateDirectory);
    fs.writeFileSync(path.join(artifact, 'kit.json'), JSON.stringify(kit.manifest), 'utf8');
    fs.writeFileSync(path.join(artifact, 'index.mjs'), kitModule(kit), 'utf8');
    const client = { closed: false, handlers: new Set(), targets: () => [{ targetId: 'page', type: 'page', url: 'app://index.html' }],
      async send(method, params) {
        if (method === 'Target.attachToTarget') return { sessionId: 'session' };
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
        if (method === 'Runtime.evaluate') {
          if (params.expression.startsWith('window.__CODEXTOPKITS_MESSAGE_LABELS__?.resolve(')) vm.runInNewContext(params.expression, { window: { __CODEXTOPKITS_MESSAGE_LABELS__: { resolve: (...args) => { reply = args; } } } });
          return { result: { value: true } };
        }
        return {};
      }, async close() { this.closed = true; } };
    const context = { stateDirectory, cdp: { acquire: async () => client, onReconnect: () => () => {} },
      log: async () => {}, setHealth() {}, onHostState(listener) { listener({ health: { plugins: [] } }); return () => {}; } };
    const runtime = await kitRuntime({ artifacts: [artifact], services: { 'chat-history': { module: new URL('../src/history-service.mjs', import.meta.url).href, options: { codexHome: directory } } } }).start(context);
    try {
      await runtime.connect();
      for (const handler of client.handlers) await handler({ method: 'Runtime.bindingCalled', sessionId: 'session', params: {
        name: '__CODEXTOPKITS_FEATURE_ACTION__', payload: JSON.stringify({ kind: 'history-index', requestId: 'three', threadId: 'stable-ui-id', turnId: 'turn', anchorItemId: 'm54' }),
      } });
      assert.equal(reply[0], 'three'); assert.equal(reply[1].messages.at(-1).ordinal, 54); assert.equal(reply[2], null);
    } finally { await runtime.close(); }
  } finally {
    if (db.isOpen) db.close();
    fs.rmSync(directory, { recursive: true });
  }
});
