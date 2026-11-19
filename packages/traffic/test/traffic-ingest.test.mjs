import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrafficLog } from '../src/traffic-log.mjs';
import { TrafficFileImporter } from '../src/traffic-ingest.mjs';

test('incremental importer commits complete UTF-8 records and resumes without duplicates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cdt-traffic-'));
  t.after(() => rm(dir, { recursive: true }));
  const filename = join(dir, 'events.jsonl'), db = join(dir, 'traffic.sqlite');
  const bytes = Buffer.from('{"value":"测试"}\n', 'utf8');
  await writeFile(filename, bytes.subarray(0, 12));
  let log = new TrafficLog(db), errors = [];
  const make = () => new TrafficFileImporter({ log, filename, source: 'test',
    consume: item => log.bytes(60000, 'test', item.value, '', 0, 1, 0), onError: error => errors.push(error),
  });
  let importer = make().start(); await importer.running;
  assert.equal(log.query({ from: 0, to: 120000 }).totals.length, 0);
  await appendFile(filename, bytes.subarray(12)); importer.schedule(); await importer.running;
  assert.equal(log.query({ from: 0, to: 120000 }).totals[0].up, 1);
  await importer.close(); log.close();
  log = new TrafficLog(db); importer = make().start(); await importer.running;
  assert.equal(log.query({ from: 0, to: 120000 }).totals[0].up, 1);
  await appendFile(filename, bytes); importer.schedule(); await importer.running;
  assert.equal(log.query({ from: 0, to: 120000 }).totals[0].up, 2);
  assert.deepEqual(errors, []); await importer.close(); log.close();
});

test('invalid complete record rolls back its batch and cursor instead of silently skipping it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cdt-traffic-'));
  t.after(() => rm(dir, { recursive: true }));
  const filename = join(dir, 'events.jsonl');
  await writeFile(filename, '{"ok":true}\nINVALID\n', 'utf8');
  const log = new TrafficLog(':memory:'), errors = [];
  const importer = new TrafficFileImporter({ log, filename, source: 'test',
    consume: () => log.bytes(60000, 'test', 'test', '', 0, 1, 0), onError: error => errors.push(error),
  }).start();
  await importer.running;
  assert.equal(errors.length, 1); assert.equal(importer.failed, true);
  assert.equal(log.query({ from: 0, to: 120000 }).totals.length, 0);
  assert.equal(log.db.prepare('SELECT * FROM traffic_import_cursor').all().length, 0);
  await importer.close(); log.close();
});
