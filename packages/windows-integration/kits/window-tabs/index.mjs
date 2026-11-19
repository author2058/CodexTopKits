import manifest from './kit.json' with { type: 'json' };
import { createWindowTabs, installWindowTabs } from '../../src/footer-features.mjs';
import { middleEllipsis } from '../../src/window-registry.mjs';
import { windowTabsCss } from '../../src/footer-styles.mjs';
export default { manifest, create: createWindowTabs, helpers: { installWindowTabs, middleEllipsis, windowTabsCss } };
