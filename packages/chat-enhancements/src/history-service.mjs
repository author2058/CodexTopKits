import path from 'node:path';
import { readMessageLabelIndex } from './message-label-history.mjs';

export const serviceApiVersion = '1.0.0';
export default async function createChatHistoryService({ codexHome } = {}, context) {
  if (codexHome !== undefined && !path.isAbsolute(codexHome)) throw new Error('codexHome must be an absolute path.');
  return {
    snapshot: () => ({}), configure() {}, removeTarget() {}, close() {},
    async receive(targetId, value) {
      if (value.kind !== 'history-index') return false;
      let result, error;
      try { result = await readMessageLabelIndex(value, codexHome ? { dbPath: path.join(codexHome, 'thread_history_1.sqlite') } : {}); }
      catch (failure) { error = { name: failure.name, message: failure.message, stack: failure.stack }; }
      const args = [value.requestId, result ?? null, error ?? null].map(item => JSON.stringify(item)).join(',');
      await context.evaluatePage(targetId, 'window.__CODEXTOPKITS_MESSAGE_LABELS__?.resolve(' + args + ')');
      return true;
    },
  };
}
