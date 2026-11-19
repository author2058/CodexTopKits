// Minimal local DOM for feature ownership and native-query lifecycle tests; no browser or network.
export function featureDom({ withQuery = true } = {}) {
  const intervals = new Map(), observers = new Set(), listeners = new Set(), events = new Map();
  class Element {
    constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.attributes = new Map(); this.className = ''; this._text = ''; this.properties = new Map();
      const attribute = key => 'data-' + key.replace(/[A-Z]/g, value => '-' + value.toLowerCase());
      this.dataset = new Proxy({}, { get: (_target, key) => this.attributes.get(attribute(key)), set: (_target, key, value) => { this.attributes.set(attribute(key), String(value)); return true; }, deleteProperty: (_target, key) => { this.attributes.delete(attribute(key)); return true; } });
      this.style = { setProperty: (key, value) => this.properties.set(key, value), getPropertyValue: key => this.properties.get(key) || '' };
      const classes = new Set(); this.classList = { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)), contains: value => classes.has(value) };
    }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this._text = value; this.children = []; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    hasAttribute(key) { return this.attributes.has(key); }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    appendChild(node) { this.append(node); return node; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    matches(selector) {
      if (selector[0] === '.') return this.className.split(' ').includes(selector.slice(1));
      if (selector.startsWith('[data-kind=')) return this.dataset.kind === selector.match(/"([^"]+)"/)[1];
      return selector === '[data-cdtk-owned]' && this.hasAttribute('data-cdtk-owned');
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelector(selector) { for (const node of this.children) { if (node.matches(selector)) return node; const found = node.querySelector(selector); if (found) return found; } return null; }
  }
  const html = new Element('html'), head = new Element('head'), body = new Element('body'), root = new Element('div'), main = new Element('main');
  root.id = 'root'; html.append(head, body); body.append(root); root.append(main);
  const findId = (node, id) => node.id === id ? node : node.children.map(child => findId(child, id)).find(Boolean);
  const query = { queryKey: ['rate-limit-status'], state: { dataUpdatedAt: Date.now(), data: { rate_limit: { primary_window: {
    used_percent: 40, limit_window_seconds: 604800, reset_at: (Date.now() + 3.5 * 86400000) / 1000,
  } } } } };
  const cache = { findAll: () => withQuery ? [query] : [], subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const client = { getQueryCache: () => cache, getQueryData() {} };
  root.__reactContainer$fixture = { memoizedProps: { client } };
  let timer = 0;
  const document = { head, body, documentElement: html, hidden: false,
    createElement: tag => new Element(tag), getElementById: id => findId(html, id),
    querySelector: selector => selector.startsWith('main.') && main.parentElement ? main : null,
    querySelectorAll: selector => selector.startsWith('main.') && main.parentElement ? [main] : [],
    addEventListener: (name, listener) => events.set(name, listener), removeEventListener: name => events.delete(name),
    defaultView: { location: { pathname: '/' }, queueMicrotask, MutationObserver: class {
      constructor(callback) { this.callback = callback; } observe() { observers.add(this); } disconnect() { observers.delete(this); }
    }, setInterval(callback, delay) { intervals.set(++timer, { callback, delay }); return timer; }, clearInterval(id) { intervals.delete(id); } },
  };
  return { document, main, root, intervals, observers, listeners, events, query,
    showQuery() { withQuery = true; },
    emitQuery() { for (const listener of listeners) listener({ query }); },
    emitDom(records) { for (const observer of observers) observer.callback(records); },
  };
}
