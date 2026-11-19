import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installImageIntegration, removeImageIntegration, imageIntegrationStatus } from '../src/image-integration.mjs';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bandwidth-rules-'));
  const codexHome = path.join(directory, 'synthetic-codex'), stateDirectory = path.join(directory, 'state');
  await fs.mkdir(codexHome);
  return { codexHome, stateDirectory };
}
test('install and remove only the owned Hook and skill, preserving unrelated settings and trust', async () => {
  const options = await fixture(), filename = path.join(options.codexHome, 'hooks.json');
  const unrelated = { matcher: 'synthetic', hooks: [{ type: 'command', command: 'unrelated-command' }] };
  const original = { unrelated: { value: '中文' }, hooks: { Stop: [unrelated], PreToolUse: [unrelated] } };
  await fs.writeFile(filename, JSON.stringify(original), 'utf8');
  const trustFile = path.join(options.codexHome, 'synthetic-trust-state');
  await fs.writeFile(trustFile, 'unchanged', 'utf8');
  assert.equal((await installImageIntegration(options)).installed, true);
  await installImageIntegration(options);
  const installed = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(installed.hooks.PreToolUse.length, 2);
  assert.deepEqual(installed.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(installed.unrelated, original.unrelated);
  const status = await imageIntegrationStatus(options);
  const skill = await fs.readFile(status.skillFile, 'utf8');
  assert.ok(!skill.includes('{{'));
  assert.equal(status.trust, 'not-checked');
  assert.equal((await removeImageIntegration(options)).removed, true);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), original);
  assert.equal(await fs.readFile(trustFile, 'utf8'), 'unchanged');
  assert.equal((await removeImageIntegration(options)).removed, false);
});
test('edited or unowned skills, invalid JSON and an existing legacy audit Hook fail visibly', async () => {
  const options = await fixture();
  const status = await installImageIntegration(options);
  await fs.appendFile(status.skillFile, '\nlocal edit', 'utf8');
  await assert.rejects(installImageIntegration(options), /local edits/);
  await assert.rejects(removeImageIntegration(options), /local edits/);
  const other = await fixture(), hooks = path.join(other.codexHome, 'hooks.json');
  await fs.writeFile(hooks, '{invalid', 'utf8');
  await assert.rejects(installImageIntegration(other), SyntaxError);
  const legacy = { hooks: { PreToolUse: [{ hooks: [{ command: '& node "C:/synthetic/image-delivery-audit.mjs" hook' }] }] } };
  await fs.writeFile(hooks, JSON.stringify(legacy), 'utf8');
  await assert.rejects(installImageIntegration(other), /another installation/);
  assert.deepEqual(JSON.parse(await fs.readFile(hooks, 'utf8')), legacy);
});

test('an adopted image Hook keeps its existing log path across installations', async () => {
  const options = await fixture(), status = await installImageIntegration(options);
  const receipt = JSON.parse(await fs.readFile(status.receiptFile, 'utf8'));
  receipt.logFile = path.join(options.codexHome, 'previous-log', 'events.jsonl');
  await fs.writeFile(status.receiptFile, JSON.stringify(receipt), 'utf8');
  assert.equal((await installImageIntegration(options)).installed, true);
  const hooks = JSON.parse(await fs.readFile(status.hooksFile, 'utf8'));
  assert.ok(hooks.hooks.PreToolUse[0].hooks[0].command.includes(receipt.logFile));
  assert.equal(JSON.parse(await fs.readFile(status.receiptFile, 'utf8')).logFile, receipt.logFile);
  assert.equal((await installImageIntegration(options)).installed, true);
});

test('updating identical standalone audit code keeps the trusted Hook command', async () => {
  const options = await fixture(), root = path.dirname(options.codexHome);
  const originalRoot = path.join(root, 'first'), updatedRoot = path.join(root, 'second');
  for (const directory of [originalRoot, updatedRoot]) {
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
    await fs.mkdir(path.join(directory, 'assets'), { recursive: true });
    await fs.writeFile(path.join(directory, 'src', 'image-delivery-audit.mjs'), "import fs from 'node:fs';\n", 'utf8');
    await fs.writeFile(path.join(directory, 'assets', 'image-skill.md'), '{{ROOT}}', 'utf8');
  }
  const status = await installImageIntegration({ ...options, assetRoot: originalRoot });
  const before = JSON.parse(await fs.readFile(status.hooksFile, 'utf8')).hooks.PreToolUse[0];
  await installImageIntegration({ ...options, assetRoot: updatedRoot });
  assert.deepEqual(JSON.parse(await fs.readFile(status.hooksFile, 'utf8')).hooks.PreToolUse[0], before);
  await fs.appendFile(path.join(updatedRoot, 'src', 'image-delivery-audit.mjs'), '// changed audit\n', 'utf8');
  await installImageIntegration({ ...options, assetRoot: updatedRoot });
  const after = JSON.parse(await fs.readFile(status.hooksFile, 'utf8')).hooks.PreToolUse[0];
  assert.notEqual(after.hooks[0].command, before.hooks[0].command);
  assert.ok(after.hooks[0].command.includes(updatedRoot));
});

test('a non-absolute adopted image log path fails without rewriting the Hook', async () => {
  const options = await fixture(), status = await installImageIntegration(options);
  const before = await fs.readFile(status.hooksFile, 'utf8'), receipt = JSON.parse(await fs.readFile(status.receiptFile, 'utf8'));
  receipt.logFile = 'relative/events.jsonl'; await fs.writeFile(status.receiptFile, JSON.stringify(receipt), 'utf8');
  await assert.rejects(installImageIntegration(options), /absolute image audit log path/);
  assert.equal(await fs.readFile(status.hooksFile, 'utf8'), before);
});
