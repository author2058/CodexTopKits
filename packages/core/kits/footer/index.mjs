import manifest from './kit.json' with { type: 'json' };
import { acquireFooter } from '../../src/renderer.mjs';

export function createFooter({ document, getHostState, onDomChange }, { acquireFooter }) {
  let lease = null;
  const refresh = () => {
    const main = document.querySelector('main.main-surface,main[class*="MainContentSurface"]');
    if (main && !lease) lease = acquireFooter(document, 'footer', getHostState(), { managerEntry: false });
    if (!main && lease) { lease.release(); lease = null; }
    lease?.setHostState(getHostState());
  };
  const unsubscribe = onDomChange(refresh);
  try { refresh(); } catch (error) { unsubscribe(); throw error; }
  return {
    acquire(owner, hostState) {
      if (!lease) throw new Error('The footer is not mounted.');
      return acquireFooter(document, owner, hostState, { managerEntry: false });
    },
    close() { unsubscribe(); lease?.release(); lease = null; },
  };
}

export default { manifest, create: createFooter, helpers: { acquireFooter } };
