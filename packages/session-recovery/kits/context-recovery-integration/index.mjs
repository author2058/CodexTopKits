import manifest from './kit.json' with { type: 'json' };

export default { manifest, create: () => ({ close() {} }), backendPath: new URL('../../src/integration.mjs', import.meta.url), assets: Object.fromEntries(manifest.assets.map(name => [name, new URL('../../' + name, import.meta.url)])) };
