import manifest from './kit.json' with { type: 'json' };
import { tableStyleCss } from '../../src/styles.mjs';
import { installScopedStyleKit } from '../../src/scoped-style-kit.mjs';

export const createTableStyle = (context, { installScopedStyleKit, tableStyleCss }) =>
  installScopedStyleKit(context, 'table-style', tableStyleCss());

export default { manifest, create: createTableStyle, helpers: { installScopedStyleKit, tableStyleCss } };
