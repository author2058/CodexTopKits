import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createManagementI18n } from '../../core/src/management-localization.mjs';
import { createLocalization } from '../../core/src/localization.mjs';

test('traffic dashboard switches cached labels without another query or replacing controls', async () => {
  const page = await fs.readFile(new URL('../assets/traffic.html', import.meta.url), 'utf8');
  assert.match(page, /<script src="\.\.\/\.\.\/management-localization\.js"><\/script>/);
  const script = page.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const ids = ['from','to','category','refresh','follow','export','status','coverage','capture','totals','modelThreads','modelRecords','endpoints','requests','connections'];
  const nodes = Object.fromEntries(ids.map(id => [id, { value:'', checked:id==='follow', dataset:{}, children:[], textContent:'', innerHTML:'', addEventListener(name, fn) { this[name]=fn; }, append(node) { this.children.push(node); } }]));
  let calls=0, languageCalls=0, stream;
  const staticTitle={textContent:'',getAttribute(name){return name==='data-i18n'?'title':null;},setAttribute(){}};
  const document = { hidden:false, documentElement:{lang:'en'}, addEventListener(){}, removeEventListener(){}, getElementById:id=>nodes[id], createElement:()=>({dataset:{}}), querySelectorAll(selector) {
    if (selector==='[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]') return [staticTitle];
    if (selector==='#category option[data-category]') return nodes.category.children;
    if (selector==='#requests details[open]') return [];
    if (selector==='[data-traffic-key]') return Object.values(nodes).flatMap(node=>[...node.innerHTML.matchAll(/<span data-traffic-key="([^"]+)"(?: data-traffic-value="([^"]*)")?><\/span>/g)].map(match=>({dataset:{trafficKey:match[1],trafficValue:match[2]?.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&')},set textContent(value){ node.rendered ??= []; node.rendered.push(value); }})));
    throw new Error(selector);
  } };
  class EventSource { constructor(url){assert.equal(url,'../../api/events');stream=this;} close(){} }
  const data={source:'fixture.db',coverage:[{id:'chromium',status:'disabled',message:'Chromium 采集未启用；模型计量不依赖 CDP。',updated:1},{id:'native',status:'error',message:'Native failure <original>',updated:1}],totals:[{layer:'http2-data',category:'model',up:3,down:4,events:1}],modelThreads:[],modelRecords:[],endpoints:[],requests:[],connections:[]};
  const fetch=async url=>{if(url==='../../api/localization'){languageCalls++;return {ok:true,json:async()=>({preference:{mode:'auto'},hostLanguage:'en-US',systemLanguage:'zh-CN'})};}calls++;return {ok:true,json:async()=>data};};
  const window = { addEventListener(){},removeEventListener(){},createCodexTopKitsManagementI18n(options){return createManagementI18n(createLocalization,options,{document,window,EventSource,AbortController,fetch});} };
  vm.runInNewContext(script,{document,window,fetch,URLSearchParams,Date,JSON,console,setInterval(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1); assert.equal(languageCalls,1); assert.equal(staticTitle.textContent,'Codex traffic'); assert.match(nodes.status.textContent,/Queried at/);
  assert.ok(nodes.coverage.rendered.includes('Chromium capture is disabled; model measurement does not depend on CDP.'));
  assert.ok(nodes.coverage.rendered.includes('Native failure <original>'));
  assert.ok(nodes.totals.rendered.includes('Model inference'));
  nodes.category.value='model'; nodes.from.value='2026-11-19T01:00'; const category=nodes.category, capture=nodes.capture, requestMarkup=nodes.requests.innerHTML;
  stream.onmessage({data:JSON.stringify({languagePreference:{mode:'fixed',locale:'zh-Hans'},hostLanguage:'en-US',systemLanguage:'zh-CN'})});
  assert.equal(calls,1); assert.equal(languageCalls,1); assert.equal(staticTitle.textContent,'Codex 流量记录'); assert.equal(document.documentElement.lang,'zh-Hans'); assert.equal(nodes.category,category); assert.equal(nodes.capture,capture); assert.equal(nodes.category.value,'model'); assert.equal(nodes.from.value,'2026-11-19T01:00'); assert.equal(nodes.requests.innerHTML,requestMarkup);
  assert.equal(nodes.category.children.find(option=>option.value==='model').textContent,'模型推理');
  assert.ok(nodes.coverage.rendered.includes('Chromium 采集未启用；模型计量不依赖 CDP。'));
  assert.match(nodes.status.textContent,/查询于/); assert.equal(nodes.capture.textContent,'继续应用级字节采集');
});
