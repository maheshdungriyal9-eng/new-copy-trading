const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-trader-test-'));
process.env.COPY_TRADING_DATA_DIR = temporary;
process.env.OFFLINE_MODE = 'true';
process.env.APP_ADMIN_PASSWORD = 'test-administrator-password-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-characters';
const validation = require('../services/validationService');
const storage = require('../services/storageService');
const config = require('../services/configService');
const cryptography = require('../services/cryptoService');
const { redact } = require('../services/redactionService');
const { SimulatedPortfolioManager } = require('../services/simulatedPortfolioManager');
const { DbService } = require('../services/dbService');
const { CopyTradingEngine, mapProductType } = require('../services/copyTradingEngine');
const { OrderQueueService } = require('../services/orderQueueService');
const auth = require('../services/authService');
const baseOrder = { tradingsymbol: 'SBIN-EQ', exchange: 'NSE', transactiontype: 'BUY', quantity: 10, ordertype: 'MARKET', price: 0, producttype: 'INTRADAY' };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await predicate()) return; await delay(5); }
  throw new Error('Timed out waiting for asynchronous result');
}
function paper() {
  let price = 100;
  const account = { id: 'paper', isSimulated: true, balance: 10000 };
  const manager = new SimulatedPortfolioManager({ persist() {}, price: () => price });
  return { account, manager, setPrice(value) { price = value; } };
}
function queueFixture(placeOrder) {
  const database = new DbService(':memory:');
  const service = { account: { id: 'child', ownerId: 'user', isSimulated: true }, session: { connected: true }, placeOrder, getOrderBook: async () => [], clearCache() {} };
  const engine = { services: { child: service }, mappings: [], validateOrder: async () => {}, addLog() {} };
  const queue = new OrderQueueService(database, engine);
  return { database, service, engine, queue };
}

test('reject invalid quantities, prices, exits, exchanges and mappings', () => {
  for (const quantity of [0, -1, 1.1, NaN, Infinity, '10bad']) assert.throws(() => validation.trade({ ...baseOrder, quantity }));
  assert.throws(() => validation.trade({ ...baseOrder, ordertype: 'LIMIT', price: 0 }));
  assert.throws(() => validation.trade({ ...baseOrder, exchange: 'WRONG' }));
  assert.throws(() => validation.trade({ ...baseOrder, reduceOnly: 'true' }));
  assert.throws(() => validation.mappings([{ masterId: 'master', childId: 'master', multiplier: 1 }], ['master']));
  assert.throws(() => validation.mappings([{ masterId: 'master', childId: 'child', multiplier: -1 }], ['master', 'child']));
  assert.throws(() => validation.mappings([{ masterId: 'master', childId: 'child', multiplier: 1 }, { masterId: 'child', childId: 'master', multiplier: 1 }], ['master', 'child']));
  assert.equal(validation.mappings([{ masterId: 'master', childId: 'child', multiplier: 1, active: false }], ['master', 'child'])[0].active, false);
});

test('authenticated encryption roundtrip and corruption detection', () => {
  const encrypted = cryptography.encrypt('private-test-token');
  assert.ok(encrypted.startsWith('gcm:'));
  assert.equal(cryptography.decrypt(encrypted), 'private-test-token');
  assert.throws(() => cryptography.decrypt(encrypted.slice(0, -2) + '00'));
  const redacted = redact({ accessToken: 'sensitive', nested: { password: 'sensitive' }, message: 'Authorization: Bearer abc123' });
  assert.ok(!JSON.stringify(redacted).includes('sensitive'));
  assert.ok(!JSON.stringify(redacted).includes('abc123'));
});

test('config encryption strips all credentials from account responses', () => {
  config.saveConfig({ users: [{ id: 'user', accounts: [{ id: 'account', accessToken: 'private-token', password: 'private-password', proxyUrl: 'http://user:pass@localhost' }], mappings: [] }] });
  const stored = fs.readFileSync(storage.dataPath('config.json'), 'utf8');
  assert.ok(!stored.includes('private-token'));
  assert.ok(!stored.includes('private-password'));
  const account = config.loadConfig().users[0].accounts[0];
  assert.equal(account.accessToken, 'private-token');
  const publicAccount = config.publicAccount(account);
  assert.equal(publicAccount.accessToken, undefined);
  assert.equal(publicAccount.password, undefined);
  assert.equal(publicAccount.proxyUrl, undefined);
});

test('invalid persisted JSON fails closed without overwriting', () => {
  fs.writeFileSync(storage.dataPath('invalid.json'), '{broken');
  assert.throws(() => storage.readJson('invalid.json', {}));
  assert.equal(fs.readFileSync(storage.dataPath('invalid.json'), 'utf8'), '{broken');
});

test('paper short roundtrip books cash and P&L once', async () => {
  const { manager, account, setPrice } = paper();
  await manager.placeOrder(account, { ...baseOrder, transactiontype: 'SELL' });
  setPrice(90);
  await manager.placeOrder(account, { ...baseOrder, reduceOnly: true });
  assert.equal(account.simState.balance, 10100);
  assert.equal(account.simState.positions.length, 0);
  assert.equal(manager.getPnlReport(account)[0].pnl, 100);
});

test('paper position reversal resets average entry price', async () => {
  const { manager, account, setPrice } = paper();
  await manager.placeOrder(account, baseOrder);
  setPrice(120);
  await manager.placeOrder(account, { ...baseOrder, transactiontype: 'SELL', quantity: 15 });
  assert.equal(account.simState.positions[0].netqty, -5);
  assert.equal(account.simState.positions[0].buyavgprice, 120);
  assert.equal(manager.getPnlReport(account)[0].pnl, 200);
});

test('paper limit orders remain pending, modify and cancel durable state', async () => {
  const { manager, account, setPrice } = paper();
  const response = await manager.placeOrder(account, { ...baseOrder, ordertype: 'LIMIT', price: 90 });
  assert.equal((await manager.getOrderBook(account))[0].status, 'pending');
  await manager.modifyOrder(account, { orderid: response.data.orderid, quantity: 5, price: 95 });
  assert.equal((await manager.getOrderBook(account))[0].quantity, '5');
  setPrice(94);
  assert.equal((await manager.getOrderBook(account))[0].status, 'executed');
  assert.equal(account.simState.balance, 9530);
  const pending = await manager.placeOrder(account, { ...baseOrder, ordertype: 'LIMIT', price: 80 });
  await manager.cancelOrder(account, pending.data.orderid);
  assert.equal((await manager.getOrderBook(account))[0].status, 'cancelled');
});

test('paper market orders reject missing quotes and over-sized exits', async () => {
  const { manager, account, setPrice } = paper();
  setPrice(null);
  await assert.rejects(manager.placeOrder(account, baseOrder), /fresh market quote/);
  setPrice(100);
  await manager.placeOrder(account, baseOrder);
  await assert.rejects(manager.placeOrder(account, { ...baseOrder, transactiontype: 'SELL', quantity: 11, reduceOnly: true }), /Exit exceeds/);
  manager.recharge(account, 20000);
  assert.equal(account.balance, 20000);
  assert.equal(account.simState.balance, 20000);
});

test('paper product aliases close the same intraday position', async () => {
  const { manager, account } = paper();
  await manager.placeOrder(account, { ...baseOrder, producttype: 'VALUEPLUS' });
  await manager.placeOrder(account, { ...baseOrder, producttype: 'MIS', transactiontype: 'SELL', reduceOnly: true });
  assert.equal(account.simState.positions.length, 0);
  assert.equal(account.simState.balance, 10000);
});

test('paper write failures do not mutate balances', async () => {
  const account = { id: 'account', isSimulated: true, balance: 10000 };
  const manager = new SimulatedPortfolioManager({ price: () => 100, persist() { throw new Error('disk full'); } });
  await assert.rejects(manager.placeOrder(account, baseOrder), /disk full/);
  assert.equal(account.balance, 10000);
  assert.equal(account.simState, undefined);
});

test('queue claims concurrent jobs once and keeps derivative metadata', async () => {
  let placements = 0;
  const fixture = queueFixture(async params => { placements++; assert.equal(params.expirydate, '2027-01-28'); await delay(10); return { status: true, data: { orderid: 'broker-order' } }; });
  await fixture.queue.start();
  const params = { ...baseOrder, requestId: 'unique-request-123', expirydate: '2027-01-28', strikeprice: 100, optiontype: 'CE' };
  const ids = await Promise.all(Array.from({ length: 8 }, () => fixture.queue.enqueueOrder('user', 'child', params)));
  assert.equal(new Set(ids).size, 1);
  await Promise.all(Array.from({ length: 10 }, () => fixture.queue.tick()));
  await until(async () => (await fixture.queue.getJobStatus(ids[0])).status === 'ACCEPTED');
  assert.equal(placements, 1);
  await assert.rejects(fixture.queue.enqueueOrder('user', 'child', { ...params, quantity: 11 }), /different order/);
  fixture.service.getOrderBook = async () => [{ orderid: 'broker-order', orderstatus: 'complete', filledshares: 10 }];
  await fixture.queue.reconcile();
  assert.equal((await fixture.queue.getJobStatus(ids[0])).status, 'COMPLETED');
  clearInterval(fixture.queue.timer);
  fixture.database.close();
});

test('unknown broker outcome never blindly retries and reconciles by correlation', async () => {
  let placements = 0;
  const fixture = queueFixture(async () => { placements++; throw new Error('ETIMEDOUT'); });
  const id = await fixture.queue.enqueueOrder('user', 'child', baseOrder);
  await until(async () => (await fixture.queue.getJobStatus(id)).status === 'RECONCILE_REQUIRED');
  await fixture.queue.tick();
  await assert.rejects(fixture.queue.retryJob(id, 'user'), /definitively failed/);
  assert.equal(placements, 1);
  const job = await fixture.queue.getJobStatus(id);
  fixture.service.getOrderBook = async () => [{ orderid: 'accepted-despite-timeout', correlationId: job.tradeParams.correlationId, orderstatus: 'complete', filledshares: 10 }];
  await fixture.queue.reconcile();
  assert.equal((await fixture.queue.getJobStatus(id)).status, 'COMPLETED');
  fixture.database.close();
});

test('definitive rejection is visible and requires explicit safe retry', async () => {
  let placements = 0;
  const fixture = queueFixture(async () => ++placements === 1 ? { status: false, message: 'Insufficient funds' } : { status: true, data: { orderid: 'retry' } });
  const id = await fixture.queue.enqueueOrder('user', 'child', baseOrder, { trackingKey: 'master_order', expectedChildQty: 10 });
  fixture.engine.mappings = [{ masterId: 'master', childId: 'child', active: true }];
  await until(async () => (await fixture.queue.getJobStatus(id)).status === 'FAILED');
  assert.equal((await fixture.queue.getCopyProgress('master_order', 'child')).blocked, true);
  await fixture.queue.retryJob(id, 'user');
  await until(async () => (await fixture.queue.getJobStatus(id)).status === 'ACCEPTED');
  assert.equal(placements, 2);
  fixture.database.close();
});

test('restart quarantines in-flight jobs rather than replaying', async () => {
  const fixture = queueFixture(async () => { throw new Error('must not place'); });
  fixture.queue.ticking = true;
  const id = await fixture.queue.enqueueOrder('user', 'child', baseOrder);
  await fixture.database.run("UPDATE jobs SET status = 'PROCESSING' WHERE id = ?", [id]);
  fixture.queue.ticking = false;
  await fixture.queue.start();
  assert.equal((await fixture.queue.getJobStatus(id)).status, 'RECONCILE_REQUIRED');
  clearInterval(fixture.queue.timer);
  fixture.database.close();
});

test('inactive mappings do not copy; simultaneous poll and webhook reserve only once', async () => {
  const engine = new CopyTradingEngine();
  engine.services = { master: { account: { ownerId: 'user' } }, child: { account: { ownerId: 'user', broker: 'angel_one' } } };
  let reserved = 0, copied = 0;
  engine.queue = { getCopyProgress: async () => ({ reserved, blocked: false }), enqueueOrder: async (owner, child, params, metadata) => { copied++; reserved = metadata.expectedChildQty; } };
  const order = { ...baseOrder, orderid: 'new-order', filledshares: 10, averageprice: 100 };
  engine.setMappings([{ masterId: 'master', childId: 'child', multiplier: 1, active: false }]);
  await engine.processExecutedOrders('master', [order]);
  assert.equal(copied, 0);
  engine.setMappings([{ masterId: 'master', childId: 'child', multiplier: 1, active: true }]);
  await Promise.all([engine.processExecutedOrders('master', [order]), engine.processExecutedOrders('master', [order])]);
  assert.equal(copied, 1);
  await engine.processExecutedOrders('master', [{ ...order, filledshares: 20 }]);
  assert.equal(copied, 2);
  assert.equal(reserved, 20);
});

test('product mappings preserve intraday, carry-forward and financed delivery', () => {
  assert.equal(mapProductType('VALUEPLUS', 'dhan', 'NSE'), 'INTRADAY');
  assert.equal(mapProductType('MIS', 'angel_one', 'NSE'), 'INTRADAY');
  assert.equal(mapProductType('NORMAL', 'angel_one', 'NFO'), 'CARRYFORWARD');
  assert.equal(mapProductType('MTF', 'dhan', 'NSE'), 'MTF');
  assert.equal(mapProductType('CNC', 'motilal', 'NSE'), 'DELIVERY');
});

test('first baseline keeps newly executed orders eligible for copying', async () => {
  const engine = new CopyTradingEngine();
  const now = Date.now();
  engine.services = { master: { account: { ownerId: 'user' }, getOrderBook: async () => [{ ...baseOrder, orderid: 'old', filledshares: 10, updatetime: new Date(now - 100000).toISOString() }, { ...baseOrder, orderid: 'new', filledshares: 10, updatetime: new Date(now + 1000).toISOString() }] }, child: { account: { ownerId: 'user' } } };
  engine.setMappings([{ masterId: 'master', childId: 'child', multiplier: 1 }]);
  await engine.primeMaster('master');
  assert.equal(engine.copiedMasterOrders.master_old.child, 10);
  assert.equal(engine.copiedMasterOrders.master_new, undefined);
});

test('Firebase rejects unsigned or fabricated identities', async () => {
  await assert.rejects(auth.verifyFirebase('not-a-token', 'project'));
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ sub: 'admin', aud: 'project' })).toString('base64url');
  await assert.rejects(auth.verifyFirebase(header + '.' + claims + '.unsigned', 'project'));
});

test('exchange-scoped Dhan mappings cannot confuse identical symbols or tokens', async () => {
  const csv = [
    'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE',
    'NSE,E,100,EQUITY,,SHEMAROO,1,,0001-01-01,0,',
    'BSE,E,200,EQUITY,,SHEMAROO,1,,0001-01-01,0,',
    'NSE,D,300,OPTIDX,,NIFTY-28JAN27-25000-CE,50,,2027-01-28,25000,CE',
    'BSE,D,300,OPTIDX,,SENSEX-28JAN27-80000-PE,20,,2027-01-28,80000,PE'
  ].join('\n');
  fs.writeFileSync(storage.dataPath('api-scrip-master.csv'), csv);
  const dhan = require('../services/dhanService');
  assert.equal(await dhan.initializeDhanService(), true);
  assert.deepEqual(dhan.resolveToDhan('SHEMAROO', 'BSE'), { securityId: '200', exchangeSegment: 'BSE_EQ' });
  assert.deepEqual(dhan.resolveToDhan('SHEMAROO-EQ', 'NSE'), { securityId: '100', exchangeSegment: 'NSE_EQ' });
  assert.equal(dhan.getDhanSymbolDetailsByToken('300', 'BFO').tradingSymbol, 'SENSEX-28JAN27-80000-PE');
  assert.equal(dhan.getDhanSymbolDetailsByToken('300', 'NFO').tradingSymbol, 'NIFTY-28JAN27-25000-CE');
  assert.equal(dhan.getDhanSymbolDetailsByToken('300'), null);
});

test('option expiries are normalized and expired contracts are excluded', async () => {
  const instruments = require('../services/instrumentService');
  const previous = instruments.getDatabase();
  assert.equal(instruments.normalizeExpiry('28JAN2027'), '2027-01-28');
  storage.writeJson('instruments.json', [
    { symbol: 'NIFTY28JAN2725000CE', underlying: 'NIFTY', exchange: 'NFO', expiry: '28JAN2027', optionType: 'CE', expiryCode: '28JAN27', strike: 25000, lotSize: 50, token: '400' },
    { symbol: 'NIFTY28JAN2025000CE', underlying: 'NIFTY', exchange: 'NFO', expiry: '28JAN2020', optionType: 'CE', strike: 25000, lotSize: 50, token: '401' }
  ]);
  await instruments.initializeInstruments();
  assert.equal(instruments.getOptionContracts('NIFTY').length, 1);
  assert.equal(instruments.resolveContract('NIFTY-28JAN27-25000-CE', 'NFO').token, '400');
  const engine = new CopyTradingEngine();
  engine.services.child = { account: { isSimulated: true } };
  await assert.rejects(engine.validateOrder('child', { ...baseOrder, exchange: 'NFO', tradingsymbol: 'NIFTY28JAN2725000CE', quantity: 51 }), /multiple of lot size/);
  storage.writeJson('instruments.json', previous);
  await instruments.initializeInstruments();
});

test('Dhan order book uses execution average, partial fill and correlation fields', async () => {
  const axios = require('axios');
  const original = axios.get;
  const Service = require('../services/dhanTradeService');
  const service = new Service({ id: 'test', clientCode: 'test', broker: 'dhan' });
  service.session.connected = true;
  service.getHeaders = () => ({});
  try {
    axios.get = async () => ({ data: [{ orderId: 'order', tradingSymbol: 'SBIN', securityId: '123', transactionType: 'BUY', exchangeSegment: 'NSE_EQ', productType: 'INTRADAY', orderType: 'LIMIT', quantity: 10, filledQty: 4, price: 110, averageTradedPrice: 100, correlationId: 'reference', orderStatus: 'PART_TRADED' }] });
    const orders = await service.getOrderBook(true);
    assert.equal(orders[0].averageprice, '100');
    assert.equal(orders[0].filledshares, '4');
    assert.equal(orders[0].orderstatus, 'part_traded');
    assert.equal(orders[0].correlationId, 'reference');
    axios.get = async () => { throw new Error('network unavailable'); };
    await assert.rejects(service.getOrderBook(true), /network unavailable/);
  } finally { axios.get = original; }
});

test('exit validation reserves pending orders instead of allowing a reversal', async () => {
  const engine = new CopyTradingEngine();
  engine.queue = { listJobs: async () => [] };
  engine.services.child = {
    account: { broker: 'angel_one', isSimulated: true, ownerId: 'user' },
    getPosition: async () => [{ tradingsymbol: 'SBIN-EQ', exchange: 'NSE', producttype: 'INTRADAY', netqty: 10 }],
    getHolding: async () => [],
    getOrderBook: async () => [{ ...baseOrder, orderid: 'pending-exit', orderstatus: 'open', transactiontype: 'SELL', quantity: 8, filledshares: 0 }]
  };
  await assert.rejects(engine.validateOrder('child', { ...baseOrder, transactiontype: 'SELL', quantity: 3, reduceOnly: true }), /Exit exceeds/);
  await engine.validateOrder('child', { ...baseOrder, transactiontype: 'SELL', quantity: 2, reduceOnly: true });
});

test('broker session reuse is isolated by owner and credentials', () => {
  const Angel = require('../services/angelOneService');
  const account = { id: 'account', ownerId: 'first', clientCode: 'shared-code', apiKey: 'test', password: 'test' };
  assert.notEqual(new Angel(account).sessionKey(), new Angel({ ...account, ownerId: 'second' }).sessionKey());
  assert.notEqual(new Angel(account).sessionKey(), new Angel({ ...account, password: 'changed' }).sessionKey());
});

test('Motilal modification uses documented fields and never rounds fractional lots', async () => {
  const axios = require('axios');
  const original = axios.post;
  const Service = require('../services/motilalService');
  const service = new Service({ id: 'test', broker: 'motilal' });
  service.session.connected = true;
  service.getHeaders = async () => ({});
  let calls = 0;
  try {
    axios.post = async (url, payload) => {
      calls++;
      assert.ok(url.endsWith('/v5/modifyorder'));
      assert.equal(payload.newquantityinlot, 2);
      assert.equal(payload.newprice, 100);
      assert.equal(payload.lastmodifiedtime, '01-Oct-2026 10:00:00');
      assert.equal(payload.orderqty, undefined);
      return { data: { status: 'SUCCESS' } };
    };
    const params = { ...baseOrder, exchange: 'NFO', tradingsymbol: 'UNLISTED', lotsize: 50, quantity: 100, price: 100, orderid: 'test', lastmodifiedtime: '01-Oct-2026 10:00:00' };
    assert.equal((await service.modifyOrder(params)).status, true);
    assert.equal((await service.modifyOrder({ ...params, quantity: 51 })).status, false);
    assert.equal(calls, 1);
  } finally { axios.post = original; }
});

test('broker streaming preserves exchange segments and decodes quote ticks', () => {
  const { UnifiedBrokerWsClient } = require('../services/unifiedWsClient');
  const client = new UnifiedBrokerWsClient();
  client.symbolToStockMap = { BANK: { exchange: 'BFO', token: '123' }, CURRENCY: { exchange: 'CDS', token: '456' } };
  assert.equal(client.resolveSymbol('BANK').exchangeType, 4);
  assert.equal(client.resolveSymbol('CURRENCY').exchangeType, 13);
  let quote;
  client.updateSymbolOHLC = (...values) => { quote = values; };
  client.isLivePrice = {};
  client.lastLiveUpdate = {};
  client.broadcastWatchlistTick = () => {};
  client.subscribe(['BANK']);
  const packet = Buffer.alloc(123);
  packet[0] = 2; packet[1] = 4;
  packet.write('123', 2);
  packet.writeBigInt64LE(12345n, 43);
  client.handleTick(packet);
  assert.equal(quote[0], 'BANK');
  assert.equal(quote[1], 123.45);
  assert.equal(client.isLivePrice.BANK, true);
});

let httpServer;
test('HTTP auth, account isolation, persistent watchlists and safe account edits', async () => {
  config.saveConfig({ users: [
    { id: 'usr_default', name: 'Administrator', accounts: [{ id: 'mine', name: 'Paper', broker: 'angel_one', isSimulated: true, balance: 10000, simState: { balance: 10000, orders: [], positions: [], holdings: [], closedTrades: [] }, accessToken: 'secret-token' }], mappings: [], groups: [] },
    { id: 'other', name: 'Other', accounts: [{ id: 'theirs', name: 'Other paper', broker: 'angel_one', isSimulated: true, balance: 5000 }], mappings: [], groups: [] }
  ] });
  const { app } = require('../server');
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => httpServer.once('listening', resolve));
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  assert.equal((await fetch(base + '/api/accounts', { headers: { 'x-user-id': 'usr_default' } })).status, 401);
  assert.equal((await fetch(base + '/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com' }) })).status, 410);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.APP_ADMIN_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (url, body, method = 'POST', extra = {}) => fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await request('/api/portfolio/theirs', undefined, 'GET')).status, 404);
  assert.equal((await request('/api/orders/cancel', { accountId: 'theirs', orderId: 'anything' })).status, 404);
  assert.equal((await request('/api/orders/modify', { accountId: 'theirs', orderid: 'anything' })).status, 404);
  assert.equal((await request('/api/connect/theirs', {})).status, 404);
  assert.equal((await request('/api/accounts', {}, 'POST', { Origin: 'https://attacker.example' })).status, 403);
  const accounts = await (await request('/api/accounts', undefined, 'GET', { 'x-user-id': 'other' })).json();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, 'mine');
  assert.equal(accounts[0].accessToken, undefined);
  const edit = await request('/api/accounts', { id: 'mine', name: 'Edited', broker: 'angel_one', isSimulated: true });
  assert.equal(edit.status, 200, await edit.text());
  assert.equal(config.loadConfig().users[0].accounts[0].simState.balance, 10000);
  assert.equal((await request('/api/watchlist', { symbol: 'SBIN-EQ', tab: '1' })).status, 200);
  assert.deepEqual(storage.readJson('watchlists.json', {})['usr_default']['1'], ['SBIN-EQ']);
  const prices = await (await request('/api/watchlist/prices', undefined, 'GET')).json();
  assert.equal(prices.prices['SBIN-EQ'].ltp, null);
  assert.equal(prices.prices['SBIN-EQ'].quoteStatus, 'unavailable');
  const queued = await (await request('/api/execute-trade', { ...baseOrder, accountId: 'mine', ordertype: 'LIMIT', price: 50, requestId: 'integration-order-id' })).json();
  assert.equal(queued.status, 'QUEUED');
  const statusResponse = await request('/api/execute-trade/status/' + queued.jobId, undefined, 'GET');
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).id, queued.jobId);
  const jobs = await (await request('/api/queue/jobs', undefined, 'GET')).json();
  assert.ok(Array.isArray(jobs));
  assert.ok(jobs.some(job => job.id === queued.jobId));
  await until(async () => (await require('../services/orderQueueService').getJobStatus(queued.jobId)).status === 'ACCEPTED');
  assert.equal((await request('/api/webhooks/dhan', { orderId: 'fake' })).status, 401);
  assert.equal((await request('/api/auth/logout', {})).status, 200);
  assert.equal((await request('/api/accounts', undefined, 'GET')).status, 401);
});

after(async () => {
  if (httpServer) {
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
  }
  require('../services/dbService').close();
  fs.rmSync(temporary, { recursive: true, force: true });
});
