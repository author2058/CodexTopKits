import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireFooter } from '../src/renderer.mjs';

function fixture() {
  const nodes = new Map(), classes = new Set();
  const element = tag => ({ tag, children: [], attributes: new Map(), textContent: '', set id(value) { this._id = value; nodes.set(value, this); }, get id() { return this._id; },
    append(...values) { this.children.push(...values); for (const node of values) node.parent = this; }, appendChild(node) { this.append(node); return node; },
    remove() { this.removed = true; if (this.id) nodes.delete(this.id); },
    setAttribute(key, value) { this.attributes.set(key, value); }, getAttribute(key) { return this.attributes.get(key) ?? null; },
  });
  return { defaultView: {}, head: element('head'), body: element('body'), createElement: element, getElementById: id => nodes.get(id),
    documentElement: { classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } } };
}

test('independent plugins share one footer, root reservation and settings state until their last release', () => {
  const document = fixture(), host = { managerUrl: 'http://127.0.0.1:1234/', health: { plugins: [{ ok: true }] } };
  const chat = acquireFooter(document, 'chat', host), windows = acquireFooter(document, 'windows', host);
  assert.equal(chat.element, windows.element); assert.equal(chat.right, windows.right); assert.equal(document.head.children.length, 1);
  assert.throws(() => acquireFooter(document, 'chat', host), /Duplicate/);
  windows.setHostState({ ...host, health: { plugins: [{ ok: false, issueCount: 12 }] } });
  assert.equal(chat.right.children[0].textContent, '12'); assert.equal(chat.right.children[0].getAttribute('href'), host.managerUrl);
  chat.release(); chat.release(); assert.ok(document.getElementById('codex-usage-toolbar')); assert.ok(document.documentElement.classList.contains('codex-usage-toolbar-active'));
  windows.release(); assert.equal(document.getElementById('codex-usage-toolbar'), undefined); assert.equal(document.documentElement.classList.contains('codex-usage-toolbar-active'), false);
  assert.equal(document.defaultView.__CODEX_DESKTOP_TOOLKIT_FOOTER__, undefined);
});

test('an explicit footer has slots but does not install the separate manager entry', () => {
  const document = fixture(), footer = acquireFooter(document, 'footer', null, { managerEntry: false });
  assert.deepEqual(footer.element.children.map(node => node.className), ['cdtk-footer-left', 'cdtk-footer-center', 'codex-toolbar-actions']);
  assert.match(document.head.children[0].textContent, /\.cdtk-footer-center\{display:flex;flex:1 1 auto;min-width:0/);
  assert.equal(footer.right.children.length, 0);
  assert.ok(!document.head.children[0].textContent.includes('.codex-usage-settings'));
  const consumer = acquireFooter(document, 'consumer', null);
  assert.equal(consumer.element, footer.element); assert.equal(consumer.right.children.length, 0);
  consumer.release(); assert.ok(document.getElementById('codex-usage-toolbar'));
  footer.release(); assert.equal(document.getElementById('codex-usage-toolbar'), undefined);
});

test('opening details acknowledges current issues; a new issue restores the total active count', () => {
  const document = fixture(), host = issues => ({ managerUrl: 'http://127.0.0.1:1234/', health: { plugins: [{ id: 'features', ok: !issues.length,
    issueCount: issues.length, message: issues.map(issue => issue.message).join('; '), issues }] } });
  const a = { key: 'a', message: 'First issue' }, b = { key: 'b', message: 'Second issue' }, c = { key: 'c', message: 'New issue' };
  const footer = acquireFooter(document, 'footer', host([a, b])), settings = footer.right.children[0], gear = String.fromCodePoint(0x2699);
  assert.equal(settings.textContent, '2'); const originalTitle = settings.getAttribute('title');
  settings.onclick({ preventDefault() { assert.fail('The settings link should still navigate.'); } });
  assert.equal(settings.textContent, gear); assert.equal(settings.getAttribute('data-codex-error-count'), '2');
  assert.equal(settings.getAttribute('title'), originalTitle, 'acknowledgement does not change existing hint text');
  footer.setHostState(host([a, b])); assert.equal(settings.textContent, gear);
  footer.setHostState(host([a])); assert.equal(settings.textContent, gear, 'a resolved issue is not a new issue');
  footer.setHostState(host([a, c])); assert.equal(settings.textContent, '2', 'display the total, including acknowledged issues');
  settings.onclick({}); assert.equal(settings.textContent, gear);
  footer.setHostState(host([{ ...c, message: 'Changed issue at the same source' }])); assert.equal(settings.textContent, '1');
  settings.onclick({});
  const translated = host([{ ...c, message: 'Changed issue at the same source' }]); translated.health.plugins[0].message = 'Localized aggregate text';
  footer.setHostState(translated); assert.equal(settings.textContent, gear, 'language changes do not create issues');
  footer.setHostState(host([])); footer.setHostState(host([a])); assert.equal(settings.textContent, '1', 'a resolved issue returning is new');
  footer.release();
});

test('a recovery grace period retains acknowledgement until its existing issue actually resolves', () => {
  const document = fixture(), issue = { key: 'chromium', message: 'Original error' }, host = plugin => ({ managerUrl: 'http://127.0.0.1:1234/', health: { plugins: [{ id: 'bandwidth', ...plugin }] } });
  const failed = { ok: false, issueCount: 1, message: issue.message, issues: [issue] };
  const footer = acquireFooter(document, 'footer', host(failed)), settings = footer.right.children[0];
  settings.onclick({}); const gear = settings.textContent;
  footer.setHostState(host({ ok: true, recovering: true, issueCount: 0, message: 'Reconnecting…', issues: [issue] }));
  footer.setHostState(host(failed)); assert.equal(settings.textContent, gear);
  footer.release();
});
