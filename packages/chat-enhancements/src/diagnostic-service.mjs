export const serviceApiVersion = '1.0.0';
export default async function createChatDiagnosticService(_options, context) {
  return {
    snapshot: () => ({}), configure() {}, removeTarget() {}, close() {},
    async receive(targetId, value) {
      if (value.kind !== 'chat-diagnostic') return false;
      if (value.feature === 'scroll' || value.feature === 'scroll-handoff') {
        if (value.feature === 'scroll' ? !Array.isArray(value.record) : !value.record || typeof value.record !== 'object' || Array.isArray(value.record)) throw new TypeError('Invalid scroll diagnostic.');
        await context.log({ event: 'chat-diagnostic', targetId, feature: value.feature, record: value.record });
        return true;
      }
      if (value.feature === 'timer') {
        const source = value.record;
        if (!source || !['render', 'waiting-for-rpc', 'conversation-unavailable', 'rpc-read', 'rpc-error', 'notification'].includes(source.kind)) throw new TypeError('Invalid timer diagnostic.');
        const fields = ['kind', 'threadId', 'turnId', 'active', 'timing', 'sourceStatus', 'reason', 'readId', 'requestedAt', 'finishedAt', 'inProgress', 'activeTurnId', 'latestTurnId', 'turnStatus', 'startedAtMs', 'finalAssistantStartedAtMs', 'durationMs', 'completionObserved', 'published', 'name', 'message', 'stack', 'method', 'observedAt'];
        const record = Object.fromEntries(fields.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
        await context.log({ event: 'chat-diagnostic', targetId, feature: 'timer', record });
        return true;
      }
      if (value.feature !== 'paste') return false;
      const { reason, applied, plainLength, htmlLength, removedLeading, removedTrailing } = value.record ?? {};
      if (!['missing-text-format', 'files-present', 'plain-has-boundary-whitespace', 'html-boundary-clean', 'content-mismatch', 'boundary-retained', 'ready'].includes(reason)
        || typeof applied !== 'boolean' || ![plainLength, htmlLength, removedLeading, removedTrailing].every(value => Number.isSafeInteger(value) && value >= 0)) throw new TypeError('Invalid paste diagnostic.');
      await context.log({ event: 'chat-diagnostic', targetId, feature: 'paste', record: { reason, applied, plainLength, htmlLength, removedLeading, removedTrailing } });
      return true;
    },
  };
}
