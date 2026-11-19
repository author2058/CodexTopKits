import manifest from './kit.json' with { type: 'json' };

export default { manifest, create: () => ({ close() {} }), backendPath: new URL('../../src/awake-bridge.mjs', import.meta.url),
  assets: Object.fromEntries(manifest.assets.map(name => [name, new URL('../../assets/' + name, import.meta.url)])) };
