#!/usr/bin/env node
import { installImageIntegration, removeImageIntegration, imageIntegrationStatus } from './image-integration.mjs';

const [action, codexHome, stateDirectory, ...extra] = process.argv.slice(2);
const actions = { 'install-rules': installImageIntegration, 'remove-rules': removeImageIntegration, 'rules-status': imageIntegrationStatus };
try {
  if (!actions[action] || !codexHome || !stateDirectory || extra.length) throw new Error('Use: codex-bandwidth install-rules|remove-rules|rules-status CODEX_HOME BANDWIDTH_STATE_DIRECTORY');
  console.log(JSON.stringify(await actions[action]({ codexHome, stateDirectory })));
} catch (error) { console.error(error); process.exitCode = 1; }
