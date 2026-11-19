import manifest from './kit.json' with { type: 'json' };
import { selectionActionsCss } from '../../src/styles.mjs';
import { installScopedStyleKit } from '../../src/scoped-style-kit.mjs';
import { installSelectionActions } from '../../src/selection-actions.mjs';

export const createSelectionActionsDelay = (context, { installScopedStyleKit, selectionActionsCss, installSelectionActions }) =>
  installScopedStyleKit(context, 'selection-actions-delay', selectionActionsCss(), installSelectionActions);

export default { manifest, create: createSelectionActionsDelay, helpers: { installScopedStyleKit, selectionActionsCss, installSelectionActions } };
