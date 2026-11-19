import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeWindowWorker } from '../src/native-window.mjs';

test('window and power events remain separate, preserving original failures', async () => {
  const worker = new NativeWindowWorker('unused'), windows = [], power = [], errors = [];
  worker.windowListener = handle => windows.push(handle); worker.windowFailure = error => errors.push(error);
  worker.powerListener = value => power.push(value);
  worker.receive(JSON.stringify({ event: 'window-placement', handle: 123 }));
  worker.receive(JSON.stringify({ event: 'power-state', ready: true, sequence: 1, type: 'resume', observedAt: 100 }));
  assert.deepEqual(windows, [123]); assert.equal(power[0].type, 'resume');
  worker.receive('not JSON'); assert.ok(errors[0] instanceof SyntaxError); assert.equal(worker.closed, true);
  await worker.close();
});

test('native window lists reject malformed protocol data instead of hiding it as no windows', async () => {
  const worker = new NativeWindowWorker('unused');
  worker.request = async () => ({ handles: [10, 20] }); assert.deepEqual(await worker.list(), [10, 20]);
  worker.request = async () => ({ handles: ['10'] }); await assert.rejects(worker.list(), TypeError);
  worker.request = async () => ({}); await assert.rejects(worker.list(), TypeError);
});

test('helper close observes process completion, including after an earlier protocol failure', async () => {
  const worker = new NativeWindowWorker('unused'); let killed = 0, finish;
  worker.closed = true;
  worker.child = { exitCode: null, signalCode: null, kill() { killed++; } };
  worker.exited = new Promise(resolve => { finish = resolve; });
  let done = false; const pending = worker.close().then(() => { done = true; });
  await Promise.resolve(); assert.equal(killed, 1); assert.equal(done, false);
  finish(); await pending; assert.equal(done, true);
});

test('foreground operations require both HWND and owner process, and malformed title results stay explicit', async () => {
  const worker = new NativeWindowWorker('unused'), calls = [];
  worker.request = async (action, args) => { calls.push({ action, args }); return { handles: ['bad'] }; };
  await assert.rejects(worker.focus(10), /identity/); assert.equal(calls.length, 0);
  await worker.focus(10, 123); assert.deepEqual(calls[0], { action: 'focus', args: { handle: 10, processId: 123 } });
  await assert.rejects(worker.find('Example'), TypeError);
  await assert.rejects(worker.findTarget('target', 123), TypeError);
  worker.request = async (action, args) => { calls.push({ action, args }); return { handles: [222] }; };
  assert.deepEqual(await worker.findTarget('target', 123), [222]);
  assert.deepEqual(calls.at(-1), { action: 'find-target', args: { targetId: 'target', processId: 123 } });
});
