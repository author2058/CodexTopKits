import os from 'node:os';
import path from 'node:path';

// Read the native per-turn index, not rollout payloads or the UI's last page.
// The UI's stable thread ID can differ from its resumed database thread ID;
// an existing message ID proves the turn's database identity before reading it.
export async function readMessageLabelIndex({ threadId, turnId, anchorItemId }, { dbPath } = {}) {
  if (![threadId, turnId, anchorItemId].every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('Message labels require a thread, turn and anchor message ID.');
  }
  const root = process.env.CODEX_SQLITE_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath || path.join(root, 'thread_history_1.sqlite'), { readOnly: true });
  try {
    const candidates = db.prepare('SELECT thread_id, status, final_agent_item_id FROM thread_turns WHERE turn_id = ?').all(turnId);
    const hasAnchor = db.prepare('SELECT 1 FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ? AND item_type = ?');
    const turn = candidates.find(row => hasAnchor.get(row.thread_id, turnId, anchorItemId, 'agentMessage'));
    if (!turn) throw new Error('Native message history has no matching turn and anchor: ' + turnId + ' / ' + anchorItemId);
    // The renderer owns liveness; an interrupted UI turn can remain inProgress on disk.
    const rows = db.prepare(`SELECT item_id, completed_at_ms, started_at_ms, created_at_ms FROM thread_items
      WHERE thread_id = ? AND turn_id = ? AND item_type = 'agentMessage'
        AND length(trim(json_extract(item_json, '$.text'), char(9) || char(10) || char(13) || ' ')) > 0
      ORDER BY rollout_ordinal`).all(turn.thread_id, turnId);
    if (!rows.some(row => row.item_id === anchorItemId)
        || (turn.final_agent_item_id && !rows.some(row => row.item_id === turn.final_agent_item_id))) {
      throw new Error('Native historical message index is incomplete: ' + turnId);
    }
    return {
      threadId, turnId,
      messages: rows.map((row, index) => ({
        itemId: row.item_id, ordinal: index + 1,
        timestamp: row.completed_at_ms ?? row.started_at_ms ?? row.created_at_ms,
      })),
    };
  } finally { db.close(); }
}
