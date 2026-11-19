import { startAppRestart } from './restart.mjs';
export const serviceApiVersion = '1.0.0';
export default async function restartService(options, context) {
  return {
    async configure() {}, snapshot() { return {}; }, removeTarget() {}, async close() {},
    async receive(targetId, value) {
      if (value.kind !== 'app-restart') return false;
      await startAppRestart(options);
      await context.log({ event: 'app-restart-requested', targetId });
      return true;
    },
  };
}
