import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareEntries } from '../src/prepare-entry.mjs';

test('portable entries bind standalone runtimes and refuse to overwrite local edits', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-entries-'));
  const options = { configPath: path.join(directory, 'toolkit.json'), powershellPath: 'C:/Standalone PowerShell/pwsh.exe' };
  const result = await prepareEntries(options);
  assert.equal(result.entries.length, 5);
  assert.match(await fs.readFile(path.join(directory, 'start-toolkit.ps1'), 'utf8'), /^#Requires -Version 7\.0/);
  assert.match(await fs.readFile(path.join(directory, 'open-manager.ps1'), 'utf8'), /^#Requires -Version 7\.0/);
  const entry = path.join(directory, 'start-toolkit.cmd');
  assert.match(await fs.readFile(entry, 'utf8'), /Standalone PowerShell/);
  await prepareEntries(options);
  await fs.appendFile(entry, 'local edit', 'utf8');
  await assert.rejects(prepareEntries(options), /local edits/);
  assert.ok((await fs.readFile(entry, 'utf8')).endsWith('local edit'));
});

test('both command entries explain a missing PowerShell before entering the script', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-entries-'));
  const powershellPath = path.join(directory, 'Removed PowerShell version', 'pwsh.exe');
  await prepareEntries({ configPath: path.join(directory, 'toolkit.json'), powershellPath });
  for (const name of ['start-toolkit', 'open-manager']) {
    const entry = path.join(directory, name + '.cmd');
    const result = spawnSync('cmd.exe', ['/d', '/c', entry], { input: '\r\n', encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes('PowerShell 7 was not found.'), result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes(powershellPath));
    assert.match(await fs.readFile(entry, 'utf8'), /pause\r\n    exit \/b 1/);
  }
});
