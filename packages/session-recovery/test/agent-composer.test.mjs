import test from 'node:test';
import assert from 'node:assert/strict';
import { installAgentComposerRestore } from '../src/agent-composer.mjs';

function fixture() {
  let mounted = false, reads = 0;
  const errors = [], document = { defaultView: {}, querySelectorAll: () => [] };
  const runtime = () => {}; runtime.e = async () => {}; runtime.m = { restore() { /* let h=o(s,p,u),g=h??c(s,p,m,u) */ } };
  const sources = {
    registration: { url: 'fixture', source: '.e(1).then(x.bind(x,"restore"))' },
    target: { url: 'fixture', source: 'subAgentActivity canInteract:!1 getConversationAncestry .find(e=>e.conversationId===r)??p(' },
    page: { url: 'fixture', source: 'onOpenBackgroundAgent openLocalConversationSubagentsPanel openLocalConversationBackgroundAgent canInteract' },
  };
  const assets = { async runtime() { reads++; return runtime; }, async find(name) {
    if (!mounted) throw new Error('Native route modules have not mounted.');
    return name.includes('registration') ? sources.registration : name.includes('resolver') ? sources.target : sources.page;
  } };
  return { document, assets, errors, identity: () => mounted ? { taskKey: 'local:thread' } : null, mount() { mounted = true; }, get reads() { return reads; } };
}

test('a composer without a conversation waits for native route mount and checks once on refresh', async () => {
  const f = fixture(), control = installAgentComposerRestore(f.document, {}, f.assets, error => f.errors.push(error), () => {}, f.identity);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.reads, 0); assert.deepEqual(f.errors, []); assert.equal(control.status().waitingForConversation, true);
    f.mount(); control.refresh(); await control.ready;
    assert.equal(f.reads, 1); assert.equal(control.status().compatibility.ok, true); assert.deepEqual(f.errors, []); assert.equal(control.status().waitingForConversation, false);
    control.refresh(); control.refresh(); assert.equal(f.reads, 1);
  } finally { control.cleanup(); }
});

test('cleanup releases readiness waiters without loading unused native modules', async () => {
  const f = fixture(), control = installAgentComposerRestore(f.document, {}, f.assets, error => f.errors.push(error), () => {}, f.identity);
  control.cleanup(); await control.ready; f.mount(); control.refresh();
  assert.equal(f.reads, 0); assert.deepEqual(f.errors, []);
});

test('a real native compatibility error keeps its original identity and is not retried', async () => {
  const f = fixture(), failure = new Error('Native route semantics changed.'); f.mount();
  f.assets.find = async () => { throw failure; };
  const control = installAgentComposerRestore(f.document, {}, f.assets, error => f.errors.push(error), () => {}, f.identity);
  try {
    await control.ready; control.refresh(); control.refresh();
    assert.equal(f.reads, 1); assert.equal(f.errors[0], failure); assert.equal(f.errors.length, 1);
    assert.equal(control.status().compatibility.message, failure.message);
  } finally { control.cleanup(); }
});
