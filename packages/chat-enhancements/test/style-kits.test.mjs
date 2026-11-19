import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createKitHost, kitModule, kitPayload } from 'codex-toolkit-core/kits';
import table from '../kits/table-style/index.mjs';
import close from '../kits/image-viewer-close/index.mjs';
import chatPlugin from '../src/index.mjs';
import { chatCss, tableStyleCss, imageViewerCloseCss, messageLabelsCss, speedHistoryCss, historyControlCss, modelDecorationsCss } from '../src/styles.mjs';
import { featureDom } from './feature-dom.mjs';

test('message timestamps keep their font size while fitting the native item gap', () => {
  assert.match(messageLabelsCss(), /font-size:15px;line-height:min\(18px,var\(--conversation-item-gap,16px\)\)/);
});

test('the table and image-close Kits mount and stop independently, including main-surface remounts', async () => {
  const fixture = featureDom(), { document } = fixture;
  const host = createKitHost([table, close], { document });
  await host.start('table-style'); await host.start('image-viewer-close');
  assert.deepEqual(document.head.children.map(style => style.textContent), [tableStyleCss(), imageViewerCloseCss()]);
  await host.stop('table-style');
  assert.deepEqual(document.head.children.map(style => style.textContent), [imageViewerCloseCss()]);
  fixture.main.remove(); host.refresh(); assert.equal(document.head.children.length, 0);
  fixture.root.append(fixture.main); host.refresh(); assert.equal(document.head.children[0].textContent, imageViewerCloseCss());
  document.defaultView.location.pathname = '/detached-window.html'; host.refresh(); assert.equal(document.head.children.length, 0);
  document.defaultView.location.pathname = '/'; host.refresh(); assert.equal(document.head.children.length, 1);
  await host.close(); assert.equal(document.head.children.length, 0); assert.equal(fixture.observers.size, 0);
});

test('each style Kit can be packed and run without the aggregate Chat renderer', async () => {
  const definitions = [];
  for (const definition of [table, close]) {
    const source = kitModule(definition); assert.ok(!source.includes('installChatRenderer'));
    definitions.push((await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))).default);
  }
  const { document } = featureDom(), window = document.defaultView;
  const snapshot = await vm.runInNewContext(kitPayload(definitions), { window, document });
  assert.deepEqual(Array.from(snapshot, item => item.id), ['table-style', 'image-viewer-close']);
  assert.equal(document.head.children.length, 2);
  await window.__CODEXTOPKITS_FEATURE_HOST__.close(); assert.equal(document.head.children.length, 0);
});

test('aggregate migration suppresses only selected styles and rejects unknown Kit names', () => {
  const full = chatCss();
  assert.equal(chatCss(false, ['table-style']), full.replace(tableStyleCss(), ''));
  assert.equal(chatCss(false, ['image-viewer-close']), full.replace(imageViewerCloseCss(), ''));
  assert.equal(chatCss(false, ['table-style', 'image-viewer-close']), full.replace(tableStyleCss(), '').replace(imageViewerCloseCss(), ''));
  assert.equal(chatCss(false, ['message-labels']), full.replace(messageLabelsCss(), ''));
  assert.equal(chatCss(false, ['history-show-all']), full.replace(speedHistoryCss('.codex-output-token-speed,.codex-turn-history-all'), speedHistoryCss('.codex-output-token-speed')).replace(historyControlCss(), ''));
  assert.equal(chatCss(false, ['history-show-all', 'output-speed']), full.replace(speedHistoryCss('.codex-output-token-speed,.codex-turn-history-all'), '').replace(historyControlCss(), ''));
  for (const [id, flag] of [['title-emoji', 'emoji'], ['fast-mode-indicator', 'fast'], ['child-model-warning', 'warning']]) {
    assert.equal(chatCss(false, [id]), full.replace(modelDecorationsCss(), modelDecorationsCss({ [flag]: false })));
    assert.doesNotThrow(() => chatPlugin({ externalKits: [id] }));
  }
  assert.doesNotThrow(() => chatPlugin({ externalKits: ['table-style', 'image-viewer-close'] }));
  assert.doesNotThrow(() => chatPlugin({ externalKits: ['message-labels'] }));
  assert.doesNotThrow(() => chatPlugin({ externalKits: ['history-show-all'] }));
  assert.doesNotThrow(() => chatPlugin({ externalKits: ['scroll-handoff-fix', 'scroll-diagnostics'] }));
  assert.throws(() => chatPlugin({ externalKits: ['other-kit'] }), /Invalid external Chat Kit/);
});
