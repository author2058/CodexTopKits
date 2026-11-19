import { launchReadAloud } from './read-aloud.mjs';

export const serviceApiVersion = '1.0.0';
export default async function createReadAloudService({ powershellPath = 'pwsh.exe' } = {}, context, overrides = {}) {
  return { snapshot: () => ({}), configure() {}, removeTarget() {}, close() {},
    async receive(targetId, value) {
      if (value.kind !== 'read-aloud') return false;
      const result = await (overrides.launchReadAloud || launchReadAloud)(value.path, value.cwd, powershellPath);
      await context.log({ event: 'read-aloud-started', targetId, ...result });
      return true;
    },
  };
}
