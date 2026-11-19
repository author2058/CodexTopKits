import http from 'node:http';
import { createLocalization } from './localization.mjs';
import { createManagementI18n } from './management-localization.mjs';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const failure = (message, status) => Object.assign(new Error(message), { status });

export async function startManager({ host, status, token, onError }) {
  const localization = createLocalization();
  const prefix = '/' + token + '/';
  const streams = new Set();
  const send = (response, result) => {
    if (response.destroyed) return;
    response.writeHead(result.status ?? 200, { 'content-type': result.subscribe ? 'text/event-stream; charset=utf-8' : result.type ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...result.headers });
    if (result.subscribe) {
      let unsubscribe = () => {};
      const cleanup = () => { if (streams.delete(cleanup)) unsubscribe(); };
      response.on('error', onError);
      response.once('close', () => { try { cleanup(); } catch (error) { onError(error); } });
      streams.add(cleanup);
      unsubscribe = result.subscribe(value => { if (!response.destroyed) response.write('data: ' + JSON.stringify(value) + '\n\n', 'utf8'); });
      return;
    }
    response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body), 'utf8');
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      const origin = 'http://127.0.0.1:' + server.address().port;
      if (request.headers.host !== origin.slice(7) || (request.headers.origin && request.headers.origin !== origin)) throw failure('Unexpected management request origin.', 403);
      const url = new URL(request.url, origin);
      if (!url.pathname.startsWith(prefix)) throw failure('Not found.', 404);
      url.pathname = '/' + url.pathname.slice(prefix.length);
      let body;
      if (request.method === 'POST') {
        if (request.headers['x-codex-toolkit-action'] !== 'manage') throw failure('Management action header is required.', 403);
        const chunks = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          // Management accepts small control parameters, never images or request bodies.
          if (bytes > 1024) throw failure('Management parameters are too large.', 413);
          chunks.push(chunk);
        }
        body = chunks.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))) : {};
      } else if (request.method !== 'GET') throw failure('Method not allowed.', 405);
      if (url.pathname === '/api/status' && request.method === 'GET') return send(response, { body: status() });
      const languageState = () => {
        const environment = host.languageEnvironment();
        return { preference: host.languagePreference(), supported: localization.supported, ...environment, hostAppearance: host.appearance(),
          locale: localization.resolve(host.languagePreference(), [environment.hostLanguage, environment.systemLanguage]) };
      };
      if (url.pathname === '/localization.mjs' && request.method === 'GET') return send(response, { type: 'application/javascript; charset=utf-8', body: 'export const createLocalization = ' + createLocalization.toString() + ';\n' });
      if (url.pathname === '/management-localization.js' && request.method === 'GET') return send(response, { type: 'application/javascript; charset=utf-8', body: 'globalThis.createCodexTopKitsManagementI18n = options => (' + createManagementI18n.toString() + ')((' + createLocalization.toString() + '), options);\n' });
      if (url.pathname === '/api/localization' && request.method === 'GET') return send(response, { body: languageState() });
      if (url.pathname === '/api/localization' && request.method === 'POST') {
        let preference;
        try { preference = localization.validatePreference(body); }
        catch (error) { if (error instanceof TypeError) error.status = 400; throw error; }
        await host.setLanguagePreference(preference); return send(response, { body: languageState() });
      }
      if (url.pathname === '/api/events' && request.method === 'GET') return send(response, { subscribe: listener => host.onState(() => listener(status())) });
      if (url.pathname === '/api/check' && request.method === 'POST') { await host.check(); return send(response, { body: status() }); }
      const entries = host.health().plugins.map(({ id }) => ({ id, instance: host.getPlugin(id) }));
      if (url.pathname === '/' && request.method === 'GET') {
        const managed = entries.filter(item => item.instance.management);
        const titles = Object.fromEntries([...managed.filter(item => item.id !== 'features'), ...managed.filter(item => item.id === 'features')].map(({ id, instance }) => [id, id === 'features' ? { en: 'All Kits', 'zh-Hans': '全部Kits' } : instance.management.title ?? id]));
        const links = Object.entries(titles).map(([id, title]) => `<li><a id="management-${id}" href="plugins/${id}/">${escape(typeof title === 'string' ? title : title.en ?? id)}</a></li>`).join('');
        const initialTitles = JSON.stringify(titles).replace(/</g, '\\u003c');
        const initialLanguage = JSON.stringify(languageState()).replace(/</g, '\\u003c');
        return send(response, { type: 'text/html; charset=utf-8', body: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CodexTopKits</title><style>:root{color-scheme:light dark}body{font:16px system-ui;background:light-dark(#fff,#17191d);color:light-dark(#1a1c1f,#e9edf5);margin:24px}a{color:light-dark(#175bb5,#8dbbff);display:inline-block;padding:4px 8px;border:1px solid light-dark(#9ca3af,#59616f);border-radius:4px;text-decoration:none}li{margin:6px 0}button{font:inherit}pre{white-space:pre-wrap;border:1px solid light-dark(#d1d5db,#424752);border-radius:6px;background:light-dark(#8080800d,#8080801a);padding:10px}pre:empty{display:none}pre span{display:block}.error{color:light-dark(#b42318,#ff9292)}</style><h1>CodexTopKits</h1><label><span id="language-label">Language</span> <select id="language"><option value="auto">Auto</option><option value="en">English</option><option value="zh-Hans">简体中文</option></select></label><ul>${links || '<li id="empty">No management pages installed.</li>'}</ul><button id="check">Check installed features</button><pre id="status" role="status"></pre><script>
const localization=(${createLocalization.toString()})();
const moduleTitles=${initialTitles};
const messages={en:{language:'Language',auto:'Auto',empty:'No management pages installed.',check:'Check installed features',ok:'OK: ',error:'Error: '},'zh-Hans':{language:'语言',auto:'自动',empty:'未安装管理页面。',check:'检查已安装功能',ok:'正常：',error:'错误：'}};
let language=${initialLanguage},health;
const text=(id,value)=>{const node=document.getElementById(id);if(node&&node.textContent!==value)node.textContent=value};
function statusLines(lines){const node=document.getElementById('status');while(node.children.length>lines.length)node.lastElementChild.remove();lines.forEach(({value,error},index)=>{let row=node.children[index];if(!row){row=document.createElement('span');node.append(row)}if(row.textContent!==value)row.textContent=value;const name=error?'error':'';if(row.className!==name)row.className=name})}
function appearance(value){const scheme=value??'';if(!['','light','dark'].includes(scheme))throw new TypeError('Invalid host appearance.');if(document.documentElement.style.colorScheme!==scheme)document.documentElement.style.colorScheme=scheme}
function render(){const locale=localization.resolve(language.preference,[language.hostLanguage,language.systemLanguage]),t=key=>localization.translate(messages,locale,key),select=document.getElementById('language');if(document.documentElement.lang!==locale)document.documentElement.lang=locale;text('language-label',t('language'));if(select.options[0].textContent!==t('auto'))select.options[0].textContent=t('auto');const value=language.preference.mode==='auto'?'auto':language.preference.locale;if(select.value!==value)select.value=value;for(const [id,title]of Object.entries(moduleTitles))text('management-'+id,typeof title==='string'?title:title[locale]??title.en??id);text('empty',t('empty'));text('check',t('check'));if(health)statusLines(health.plugins.map(x=>({value:t(x.ok?'ok':'error')+x.id+' — '+x.message,error:!x.ok})))}
function show(data){if(Object.hasOwn(data,'hostAppearance'))appearance(data.hostAppearance);if(data.languagePreference)language={preference:data.languagePreference,hostLanguage:data.hostLanguage,systemLanguage:data.systemLanguage};health=data.health;render()}
async function refresh(){const response=await fetch('api/status');health=(await response.json()).health;render()}
document.getElementById('language').onchange=async event=>{const value=event.target.value,preference=value==='auto'?{mode:'auto'}:{mode:'fixed',locale:value};try{const response=await fetch('api/localization',{method:'POST',headers:{'x-codex-toolkit-action':'manage'},body:JSON.stringify(preference)});const data=await response.json();if(!response.ok)throw new Error(data.error.message)}catch(error){render();statusLines([{value:error.message,error:true}]);throw error}};
document.getElementById('check').onclick=async()=>{const button=document.getElementById('check');button.disabled=true;try{const response=await fetch('api/check',{method:'POST',headers:{'x-codex-toolkit-action':'manage'}});const data=await response.json();if(!response.ok)throw new Error(data.error.message);await refresh()}catch(error){statusLines([{value:error.message,error:true}])}finally{button.disabled=false}};appearance(language.hostAppearance);render();new EventSource('api/events').onmessage=event=>show(JSON.parse(event.data));</script></html>` });
      }
      const match = /^\/plugins\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(url.pathname);
      const plugin = match && entries.find(item => item.id === match[1]);
      if (plugin?.instance.management) {
        if (!match[2]) { response.writeHead(302, { location: prefix + 'plugins/' + match[1] + '/' }); return response.end(); }
        url.pathname = match[2];
        const result = await plugin.instance.management.request({ method: request.method, url, body });
        if (result) return send(response, result);
      }
      throw failure('Not found.', 404);
    })().catch(error => {
      if (!error.status) onError(error);
      if (!response.headersSent) send(response, { status: error.status ?? (error instanceof SyntaxError ? 400 : 500), body: { error: { name: error.name, code: error.code, message: error.message } } });
      else response.destroy(error);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}${prefix}`, close: async () => {
    const errors = [];
    for (const cleanup of streams) { try { cleanup(); } catch (error) { errors.push(error); } }
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (errors.length) throw new AggregateError(errors, 'Management event subscription cleanup failed.', { cause: errors[0] });
  } };
}
