const AngelOneService = require('./angelOneService');
const MotilalService = require('./motilalService');
const DhanTradeService = require('./dhanTradeService');
const storage = require('./storageService');
const validation = require('./validationService');
const { redact } = require('./redactionService');

function mapProductType(product, broker, exchange) {
  const normalized = String(product || 'DELIVERY').toUpperCase();
  const derivative = ['NFO', 'BFO', 'NSEFO', 'BSEFO', 'MCX', 'CDS'].includes(exchange);
  const intraday = ['INTRADAY', 'MIS', 'VALUEPLUS'].includes(normalized);
  const financed = ['MARGIN', 'MTF'].includes(normalized);
  if (broker === 'motilal') return intraday ? 'VALUEPLUS' : derivative || financed ? 'NORMAL' : 'DELIVERY';
  if (broker === 'angel_one') return intraday ? 'INTRADAY' : derivative ? 'CARRYFORWARD' : financed ? 'MARGIN' : 'DELIVERY';
  return intraday ? 'INTRADAY' : derivative ? 'MARGIN' : financed ? 'MTF' : 'CNC';
}

function executionTime(value) {
  if (!value) return NaN;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:/.test(text)) return Date.parse(text.replace(' ', 'T') + '+05:30');
  const indian = text.match(/^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2})$/);
  if (indian) return Date.parse(indian[2] + ' ' + indian[1] + ' ' + indian[3] + ' ' + indian[4] + ' GMT+0530');
  return Date.parse(text);
}

class CopyTradingEngine {
  constructor() {
    this.services = Object.create(null);
    this.mappings = [];
    this.logs = [];
    this.copiedMasterOrders = storage.readJson('copied_orders.json', {});
    this.primedMasters = new Set(this.copiedMasterOrders.__primedMasters || []);
    this.masterPollers = {};
    this.masterLocks = new Map();
    this.primeLocks = new Map();
    this.activatedAt = new Map();
    this.started = false;
  }
  addLog(entry) { this.logs.unshift(redact(entry)); this.logs = this.logs.slice(0, 500); }
  getLogs() { return this.logs; }
  clearLogs(accountIds, userId) { this.logs = this.logs.filter(log => !accountIds.includes(log.accountId) && log.userId !== userId); }
  saveCopiedOrders() {
    this.copiedMasterOrders.__primedMasters = [...this.primedMasters];
    storage.writeJson('copied_orders.json', this.copiedMasterOrders);
  }
  initializeService(account) {
    const Constructor = { angel_one: AngelOneService, motilal: MotilalService, dhan: DhanTradeService }[account.broker];
    if (!Constructor) validation.reject('Unsupported broker');
    const service = new Constructor(account, entry => this.addLog(entry));
    this.services[account.id] = service;
    if (this.started) this.syncMasterPollers();
    return service;
  }
  removeService(accountId) {
    clearInterval(this.masterPollers[accountId]);
    delete this.masterPollers[accountId];
    delete this.services[accountId];
  }
  setMappings(mappings) {
    const valid = validation.mappings(mappings, Object.keys(this.services));
    for (const mapping of valid) {
      if (this.services[mapping.masterId].account.ownerId !== this.services[mapping.childId].account.ownerId) validation.reject('Cross-user mappings are prohibited');
      if (!this.activatedAt.has(mapping.masterId)) this.activatedAt.set(mapping.masterId, Date.now());
    }
    this.mappings = valid;
    if (this.started) this.syncMasterPollers();
  }
  start() { this.started = true; this.syncMasterPollers(); }
  syncMasterPollers() {
    const active = new Set(this.mappings.filter(mapping => mapping.active).map(mapping => mapping.masterId));
    for (const masterId of Object.keys(this.masterPollers)) {
      if (!active.has(masterId)) { clearInterval(this.masterPollers[masterId]); delete this.masterPollers[masterId]; }
    }
    for (const masterId of active) {
      if (this.masterPollers[masterId]) continue;
      const poll = async () => {
        const service = this.services[masterId];
        if (!service || (!service.account.isSimulated && !service.session.connected) || this.masterLocks.has(masterId)) return;
        try {
          await this.primeMaster(masterId);
          await this.processExecutedOrders(masterId, await service.getOrderBook(true));
        } catch (error) {
          this.addLog({ accountId: masterId, timestamp: new Date().toISOString(), type: 'error', message: error.message });
        }
      };
      this.masterPollers[masterId] = setInterval(poll, this.services[masterId]?.account.isSimulated ? 1000 : 15000);
      this.masterPollers[masterId].unref?.();
      poll();
    }
  }
  async primeMaster(masterId) {
    if (this.primedMasters.has(masterId)) return;
    if (this.primeLocks.has(masterId)) return this.primeLocks.get(masterId);
    const promise = (async () => {
      const orders = await this.services[masterId].getOrderBook(true);
      if (!Array.isArray(orders)) throw new Error('Cannot establish master order baseline');
      for (const order of orders) {
        const timestamp = executionTime(order.updatetime);
        if (Number.isFinite(timestamp) && timestamp >= (this.activatedAt.get(masterId) || Date.now())) continue;
        const quantity = this.filledQuantity(order);
        if (!quantity || !order.orderid) continue;
        const key = masterId + '_' + order.orderid;
        if (this.copiedMasterOrders[key]) continue;
        this.copiedMasterOrders[key] = {};
        for (const mapping of this.mappings.filter(entry => entry.active && entry.masterId === masterId)) {
          this.copiedMasterOrders[key][mapping.childId] = Math.floor(quantity * mapping.multiplier);
        }
      }
      this.primedMasters.add(masterId);
      this.saveCopiedOrders();
    })();
    this.primeLocks.set(masterId, promise);
    try { await promise; } finally { this.primeLocks.delete(masterId); }
  }
  filledQuantity(order) {
    const complete = ['executed', 'complete', 'traded', 'trd'].includes(String(order.orderstatus || order.status || '').toLowerCase());
    const quantity = Number(order.filledshares ?? order.totalqtytraded ?? (complete ? order.quantity : 0));
    return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
  }
  async validateOrder(accountId, params) {
    const service = this.services[accountId];
    if (!service) validation.reject('Account not found');
    if (['NFO', 'BFO', 'MCX', 'CDS'].includes(params.exchange)) {
      const contract = require('./instrumentService').getDatabase().find(item => item.symbol === params.tradingsymbol && item.exchange === params.exchange);
      const dhan = require('./dhanService');
      const details = dhan.getDhanSymbolDetails(params.tradingsymbol, params.exchange);
      const lotSize = Number(contract?.lotSize || details?.lotSize || dhan.getDhanLotSize(params.tradingsymbol, params.exchange));
      if (!Number.isSafeInteger(lotSize) || lotSize <= 0) validation.reject('Contract lot size is unavailable; refresh instruments');
      if (params.quantity % lotSize !== 0) validation.reject('Quantity must be a multiple of lot size ' + lotSize);
    }
    if (params.reduceOnly) {
      service.clearCache?.();
      const [positions, holdings] = await Promise.all([service.getPosition(), service.getHolding()]);
      const product = mapProductType(params.producttype, service.account.broker, params.exchange);
      const position = positions.find(item => item.tradingsymbol === params.tradingsymbol && item.exchange === params.exchange && mapProductType(item.producttype, service.account.broker, item.exchange) === product);
      const holding = holdings.find(item => item.tradingsymbol === params.tradingsymbol && item.exchange === params.exchange);
      const net = position ? Number(position.netqty) : ['DELIVERY', 'CNC'].includes(product) && holding ? Number(holding.quantity) : 0;
      if (!net || params.quantity > Math.abs(net) || params.transactiontype !== (net > 0 ? 'SELL' : 'BUY')) validation.reject('Exit exceeds the current position or uses the wrong side/product');
    }
  }
  getChildOrderParams(broker, exchange, side, masterPrice) {
    if (broker === 'angel_one') return { childPrice: 0, childOrderType: 'MARKET' };
    if (!(masterPrice > 0)) throw new Error('Confirmed master execution price is required for child limit order');
    const buffer = broker === 'motilal' ? 0.005 : ['NFO', 'BFO', 'MCX', 'CDS'].includes(exchange) ? 0.02 : 0.01;
    const tick = exchange === 'CDS' ? 0.0025 : 0.05;
    const raw = masterPrice * (side === 'BUY' ? 1 + buffer : 1 - buffer);
    return { childPrice: Number((Math.round(raw / tick) * tick).toFixed(exchange === 'CDS' ? 4 : 2)), childOrderType: 'LIMIT' };
  }
  async handleCopyTrade(masterId, params) {
    const service = this.services[masterId];
    if (!service) throw new Error('Master service is unavailable');
    await this.primeMaster(masterId);
    const response = await service.placeOrder(params);
    if (!response || !(response.status === true || response.status === 'SUCCESS' || response.success === true)) return { success: false, masterResponse: response, error: response?.message || 'Master order rejected' };
    service.clearCache?.();
    return { success: true, masterResponse: response, childResponses: [] };
  }
  async processExecutedOrders(masterId, orders) {
    const previous = this.masterLocks.get(masterId) || Promise.resolve();
    const processing = previous.catch(() => {}).then(async () => {
      if (!this.services[masterId] || !Array.isArray(orders)) return;
      const queue = this.queue || require('./orderQueueService');
      for (const order of orders) {
        const filled = this.filledQuantity(order);
        if (!filled || !order.orderid) continue;
        const trackingKey = masterId + '_' + order.orderid;
        for (const mapping of this.mappings.filter(entry => entry.active && entry.masterId === masterId)) {
          const child = this.services[mapping.childId];
          if (!child) continue;
          const expected = filled * mapping.multiplier;
          if (!Number.isSafeInteger(expected) || expected <= 0) {
            this.addLog({ timestamp: new Date().toISOString(), accountId: mapping.childId, type: 'error', message: 'Copy quantity is fractional; adjust multiplier' });
            continue;
          }
          const progress = await queue.getCopyProgress(trackingKey, mapping.childId);
          const historical = this.copiedMasterOrders[trackingKey];
          const baseline = typeof historical === 'number' ? historical * mapping.multiplier : Number(historical?.[mapping.childId] || 0);
          const reserved = Math.max(baseline, progress.reserved);
          if (expected <= reserved || progress.blocked) continue;
          const exchange = order.exchange;
          const side = String(order.transactiontype || order.buyorsell || '').toUpperCase();
          const { childPrice, childOrderType } = this.getChildOrderParams(child.account.broker, exchange, side, Number(order.averageprice || 0));
          const params = { tradingsymbol: order.tradingsymbol, symboltoken: order.symboltoken, exchange, transactiontype: side, quantity: expected - reserved, price: childPrice, ordertype: childOrderType, producttype: mapProductType(order.producttype, child.account.broker, exchange), expiry: order.expiry, optiontype: order.optiontype, strike: order.strike };
          await this.validateOrder(mapping.childId, validation.trade(params));
          await queue.enqueueOrder(child.account.ownerId, mapping.childId, params, { trackingKey, expectedChildQty: expected, masterOrderId: order.orderid });
        }
      }
    });
    this.masterLocks.set(masterId, processing);
    try { await processing; } finally { if (this.masterLocks.get(masterId) === processing) this.masterLocks.delete(masterId); }
  }
  async handleWebhook(broker, payload) {
    const clientCode = payload.dhanClientId || payload.clientcode || payload.clientCode;
    const id = payload.orderId || payload.orderid;
    const service = Object.values(this.services).find(entry => entry.account.broker === broker && String(entry.account.clientCode) === String(clientCode));
    if (!service || !id || !this.mappings.some(mapping => mapping.active && mapping.masterId === service.account.id)) throw new Error('Unknown webhook account or order');
    await this.primeMaster(service.account.id);
    const orders = await service.getOrderBook(true);
    const order = orders.find(entry => String(entry.orderid) === String(id));
    if (!order) throw new Error('Webhook execution is not yet confirmed by broker');
    await this.processExecutedOrders(service.account.id, [order]);
  }
  handleDhanWebhook(payload) { return this.handleWebhook('dhan', payload); }
  handleAngelOneWebhook(payload) { return this.handleWebhook('angel_one', payload); }
}
module.exports = new CopyTradingEngine();
module.exports.CopyTradingEngine = CopyTradingEngine;
module.exports.mapProductType = mapProductType;
