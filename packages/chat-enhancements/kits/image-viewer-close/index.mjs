import manifest from './kit.json' with { type: 'json' };
import { imageViewerCloseCss } from '../../src/styles.mjs';
import { installScopedStyleKit } from '../../src/scoped-style-kit.mjs';

export const createImageViewerClose = (context, { installScopedStyleKit, imageViewerCloseCss }) =>
  installScopedStyleKit(context, 'image-viewer-close', imageViewerCloseCss());

export default { manifest, create: createImageViewerClose, helpers: { installScopedStyleKit, imageViewerCloseCss } };
