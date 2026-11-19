import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { featurePayload, resolveFeatures } from './features.mjs';

let definitions = [];
process.on('message', async message => {
  try {
    let result;
    if (message.action === 'load') {
      definitions = [];
      for (const directory of message.value.directories) definitions.push((await import(pathToFileURL(path.join(directory, 'index.mjs')).href)).default);
      result = resolveFeatures(definitions).map(value => value.manifest);
    } else if (message.action === 'build') result = featurePayload(definitions, message.value);
    else throw new Error('Unknown feature-loader action: ' + message.action);
    process.send({ id: message.id, result });
  } catch (error) { process.send({ id: message.id, error: { name: error.name, message: error.message, stack: error.stack, code: error.code } }); }
});
