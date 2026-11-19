import manifest from './kit.json' with { type: 'json' };
import { createAutoSleep, installAutoSleepButton } from '../../src/footer-features.mjs';
import { autoSleepCss } from '../../src/footer-styles.mjs';
export default { manifest, create: createAutoSleep, helpers: { installAutoSleepButton, autoSleepCss } };
