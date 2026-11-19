export const serviceApiVersion = '1.0.0';
export default async function createModelProtectionService({ legacyPlugin = 'session' } = {}, context) {
  const owner = context.getPlugin?.(legacyPlugin);
  if (!owner?.modelProtectionHandedOff) throw new Error('Session Recovery must hand off agent model protection before enabling this Kit.');
  return { snapshot: () => ({}), configure() {}, receive: () => false, removeTarget() {}, close() {} };
}
