import manifest from './kit.json' with { type: 'json' };

export default { manifest, create: () => ({ close() {} }), backendPath: new URL('../../src/image-reference-transform.mjs', import.meta.url) };
