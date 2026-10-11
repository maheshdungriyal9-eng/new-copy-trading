const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function frontend(filename = 'app_v6.js') {
  const elements = new Map();
  const element = () => {
    const classes = new Set();
    const attributes = new Map();
    return { value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle(name) { if (classes.has(name)) classes.delete(name); else classes.add(name); }, contains: name => classes.has(name) }, setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name), addEventListener() {}, appendChild() {}, replaceChildren() {}, querySelectorAll: () => [], querySelector: () => null, getAttribute: name => attributes.get(name) ?? null };
  };
  const app = element();
  const document = { addEventListener() {}, querySelectorAll: () => [], querySelector: selector => selector === '.app-container' ? app : null, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, body: element(), documentElement: element() };
  const context = vm.createContext({ document, console, crypto, URL, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, fetch: async () => ({ ok: true, json: async () => [] }), addEventListener() {}, innerWidth: 1200, navigator: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { protocol: 'http:', host: 'localhost', reload() {} }, history: { pushState() {}, back() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }), alert() {}, confirm: () => true });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend', filename), 'utf8'), context);
  return { context, elements, app, run: source => vm.runInContext(source, context) };
}

test('login overlay is visible by default in source and served styles', () => {
  for (const filename of ['style.css', 'style.min.css']) {
    const css = fs.readFileSync(path.join(__dirname, '../../frontend', filename), 'utf8');
    const overlay = css.match(/\.auth-screen\s*\{([^}]+)\}/)?.[1];
    assert.ok(overlay, filename);
    assert.match(overlay, /display:\s*flex\s*[;}]/, filename);
    assert.match(overlay, /position:\s*fixed\s*[;}]/, filename);
    assert.doesNotMatch(overlay, /display:\s*none|visibility:\s*hidden|pointer-events:\s*none/, filename);
    assert.match(css, /\.hidden\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/, filename);
  }
});

for (const filename of ['app_v6.js', 'app_v6.min.js']) {
  test(`login unlocks the dashboard and session expiry locks it again (${filename})`, () => {
    const client = frontend(filename);
    client.run('loadData = () => {}; startLogPolling = () => {}; startPricePolling = () => {}; restoreOrderMonitoring = () => {}; showLogin()');
    const authScreen = client.elements.get('auth-screen');
    assert.equal(authScreen.classList.contains('hidden'), false);
    assert.equal(authScreen.style.display, '');
    assert.equal(client.app.getAttribute('inert'), '');
    client.run("loginUser({id: 'usr_default', name: 'Administrator'})");
    assert.equal(authScreen.classList.contains('hidden'), true);
    assert.equal(authScreen.style.display, 'none');
    assert.equal(client.app.getAttribute('inert'), null);
    assert.equal(client.elements.get('user-display-name').textContent, 'Administrator');
    client.run('showLogin()');
    assert.equal(authScreen.classList.contains('hidden'), false);
    assert.equal(authScreen.style.display, '');
    assert.equal(client.app.getAttribute('inert'), '');
  });
}

test('frontend loads without a forged default session', () => {
  const client = frontend();
  assert.equal(client.run('typeof defaultUser'), 'undefined');
  assert.equal(client.run('escapeHtml(' + JSON.stringify('<img src=x onerror=alert(1)>"\'') + ')'), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;');
  assert.equal(client.run('displayPrice(null)'), '—');
});

test('frontend retry identity is stable only for unchanged orders', () => {
  const client = frontend();
  const first = client.run('getOrderRequestId({quantity: 10})');
  assert.equal(client.run('getOrderRequestId({quantity: 10})'), first);
  assert.notEqual(client.run('getOrderRequestId({quantity: 11})'), first);
});

test('exit exchange can be initialized and cannot be changed by toggles', () => {
  const client = frontend();
  client.run("currentSelectedStock = {symbol:'NIFTY', exchange:'NFO', price:100}; isExitOrder = true; calculateOrderMargin = () => {}; setOrderExchange('NFO', true)");
  assert.equal(client.run('currentOrderExchange'), 'NFO');
  client.run("setOrderExchange('NSE')");
  assert.equal(client.run('currentOrderExchange'), 'NFO');
});

test('frontend tolerates unavailable quotes and shows absent market depth', () => {
  const client = frontend();
  client.run("handleWatchlistPricesData({prices:{'SBIN-EQ':{ltp:null,quoteStatus:'unavailable'},'NIFTY-EQ':{ltp:null,quoteStatus:'unavailable'},'SENSEX-EQ':{ltp:null,quoteStatus:'unavailable'}},marketOpen:false})");
  client.run('updateBSPrice(null, null)');
  assert.equal(client.elements.get('bs-price').textContent, 'Unavailable');
  client.run('updateBSMarketDepthPrices(null, null)');
  assert.equal(client.elements.get('bs-depth-rows').textContent, 'Market depth unavailable');
});

test('quote freshness uses received timestamps and unavailable quotes stay neutral', () => {
  const client = frontend();
  client.run("handleWatchlistPricesData({prices:{'NIFTY-EQ':{ltp:null,quoteStatus:'unavailable'}},marketOpen:false})");
  assert.equal(client.elements.get('watchlist-last-tick').textContent, 'No quote received');
  assert.equal(client.elements.get('index-nifty-ltp').className, 'index-ltp text-muted');
  assert.equal(client.elements.get('market-status-badge').className, 'text-muted');
  client.run("handleWatchlistPricesData({prices:{'NIFTY-EQ':{ltp:20000,updatedAt:Date.now()-120000,quoteStatus:'stale'}},marketOpen:false})");
  assert.match(client.elements.get('watchlist-last-tick').textContent, /Stale/);
  assert.equal(client.run("executionLabel('ACCEPTED')"), 'Accepted · awaiting fill');
  assert.equal(client.run("executionLabel('RECONCILE_REQUIRED')"), 'Broker check required');
});

test('paper practice offers connected paper accounts only', () => {
  const client = frontend();
  const names = [];
  client.run("document.getElementById('sim-master')");
  client.elements.get('sim-master').appendChild = option => names.push(option.textContent);
  client.run("accounts = [{id:'paper',name:'Practice',isSimulated:true,connected:true},{id:'live',name:'Real',isSimulated:false,connected:true},{id:'disconnected',name:'Disconnected',isSimulated:true,connected:false}]; populateSimulatorDropdowns()");
  assert.equal(names.length, 1);
  assert.match(names[0], /Practice.*Paper/);
});
