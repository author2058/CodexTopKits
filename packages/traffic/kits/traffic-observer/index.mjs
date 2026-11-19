import manifest from './kit.json' with { type: 'json' };

export default { manifest, create: () => ({ close() {} }), backendPath: new URL('../../src/traffic-service.mjs', import.meta.url), assets: Object.fromEntries(manifest.assets.map(name => [name, new URL('../../src/' + name, import.meta.url)])) };
