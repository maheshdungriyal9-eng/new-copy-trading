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
  if (broker === 'motilal') return intraday ? 'VALUEPLUS' : derivative ? 'NORMAL' : financed ? 'MTF' : 'DELIVERY';
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
    this.primedLinks = new Set(this.copiedMasterOrders.__primedLinks || []);
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
    this.copiedMasterOrders.__primedLinks = [...this.primedLinks];
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
      if (this.services[mapping.masterId].account.isSimulated && !this.services[mapping.childId].account.isSimulated) validation.reject('Paper source accounts can only copy to paper followers');
      const link = mapping.masterId + ':' + mapping.childId + ':' + mapping.multiplier;
      if (!this.activatedAt.has(link)) this.activatedAt.set(link, Date.now());
    }
    const activeLinks = new Set(valid.filter(mapping => mapping.active).map(mapping => mapping.masterId + ':' + mapping.childId + ':' + mapping.multiplier));
    for (const link of this.primedLinks) if (!activeLinks.has(link)) this.primedLinks.delete(link);
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
    const pending = this.mappings.filter(mapping => mapping.active && mapping.masterId === masterId && !this.primedLinks.has(masterId + ':' + mapping.childId + ':' + mapping.multiplier));
    if (!pending.length) return;
    if (this.primeLocks.has(masterId)) return this.primeLocks.get(masterId);
    const promise = (async () => {
      const orders = await this.services[masterId].getOrderBook(true);
      if (!Array.isArray(orders)) throw new Error('Cannot establish master order baseline');
      const previous = structuredClone(this.copiedMasterOrders);
      const previousLinks = new Set(this.primedLinks);
      try {
        for (const mapping of pending) {
          const link = masterId + ':' + mapping.childId + ':' + mapping.multiplier;
          for (const order of orders) {
            const timestamp = executionTime(order.updatetime);
            if (Number.isFinite(timestamp) && timestamp >= (this.activatedAt.get(link) || Date.now())) continue;
            const quantity = this.filledQuantity(order);
            if (!quantity || !order.orderid) continue;
            const key = masterId + '_' + order.orderid;
            if (typeof this.copiedMasterOrders[key] === 'number') continue;
            (this.copiedMasterOrders[key] ||= {})[mapping.childId] = quantity * mapping.multiplier;
          }
          this.primedLinks.add(link);
        }
        this.primedMasters.add(masterId);
        this.saveCopiedOrders();
      } catch (error) { this.copiedMasterOrders = previous; this.primedLinks = previousLinks; throw error; }
    })();
    this.primeLocks.set(masterId, promise);
    try { await promise; } finally { this.primeLocks.delete(masterId); }
  }
  filledQuantity(order) {
    const complete = ['executed', 'complete', 'traded', 'trd'].includes(String(order.orderstatus || order.status || '').toLowerCase());
    const quantity = Number(order.filledshares ?? order.totalqtytraded ?? (complete ? order.quantity : 0));
    return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
  }
  async validateOrder(accountId, params, jobId) {
    const service = this.services[accountId];
    if (!service) validation.reject('Account not found');
    const matchingContract = require('./instrumentService').resolveContract(params.tradingsymbol, params.exchange);
    if (!service.account.isSimulated && service.account.broker !== 'dhan' && (!matchingContract || (matchingContract.token && String(params.symboltoken) !== String(matchingContract.token)))) validation.reject('Symbol, token and exchange do not match the instrument master');
    const dhanContract = service.account.broker === 'dhan' ? require('./dhanService').getDhanSymbolDetails(params.tradingsymbol, params.exchange) : null;
    if (!service.account.isSimulated && service.account.broker === 'dhan' && (!dhanContract || (dhanContract.expiryDate && dhanContract.expiryDate < new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })))) validation.reject('Dhan instrument is missing or expired');
    if (matchingContract?.expiry && matchingContract.expiry.slice(0, 10) < new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })) validation.reject('Contract has expired');
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
      const [positions, holdings, orders] = await Promise.all([service.getPosition(true), service.getHolding(true), service.getOrderBook(true)]);
      const product = mapProductType(params.producttype, service.account.broker, params.exchange);
      const sameSymbol = symbol => symbol === params.tradingsymbol || (matchingContract && require('./instrumentService').resolveContract(symbol, params.exchange)?.symbol === matchingContract.symbol);
      const position = positions.find(item => sameSymbol(item.tradingsymbol) && item.exchange === params.exchange && mapProductType(item.producttype, service.account.broker, item.exchange) === product);
      const holding = holdings.find(item => sameSymbol(item.tradingsymbol) && item.exchange === params.exchange);
      const net = position ? Number(position.netqty) : ['DELIVERY', 'CNC'].includes(product) && holding ? Number(holding.quantity) : 0;
      const pending = orders.filter(order => String(order.orderid) !== String(params.orderid || '') && sameSymbol(order.tradingsymbol) && order.exchange === params.exchange && String(order.transactiontype).toUpperCase() === params.transactiontype && mapProductType(order.producttype, service.account.broker, order.exchange) === product && !['complete', 'executed', 'traded', 'trd', 'rejected', 'cancelled', 'canceled', 'expired'].includes(String(order.orderstatus || order.status).toLowerCase()));
      let reserved = pending.reduce((total, order) => total + Math.max(0, Number(order.quantity) - Number(order.filledshares || 0)), 0);
      const queue = this.queue || require('./orderQueueService');
      if (queue.listJobs) {
        const jobs = await queue.listJobs(service.account.ownerId);
        for (const job of jobs) {
          if (job.id === jobId || job.targetId !== accountId || !['PROCESSING', 'ACCEPTED', 'RECONCILE_REQUIRED'].includes(job.status)) continue;
          const trade = job.tradeParams;
          if (!sameSymbol(trade.tradingsymbol) || trade.exchange !== params.exchange || trade.transactiontype !== params.transactiontype || mapProductType(trade.producttype, service.account.broker, trade.exchange) !== product) continue;
          if (orders.some(order => String(order.orderid) === String(job.result?.brokerOrderId))) continue;
          reserved += Math.max(0, Number(trade.quantity) - Number(job.result?.filledQuantity || 0));
        }
      }
      if (!net || params.quantity > Math.max(0, Math.abs(net) - reserved) || params.transactiontype !== (net > 0 ? 'SELL' : 'BUY')) validation.reject('Exit exceeds the current position or uses the wrong side/product');
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
          try {
          if (this.services[masterId].account.isSimulated && !child.account.isSimulated) throw new Error('Paper source accounts cannot copy to live followers');
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
          const params = { tradingsymbol: order.tradingsymbol, symboltoken: order.symboltoken, exchange, transactiontype: side, quantity: expected - reserved, price: childPrice, ordertype: childOrderType, producttype: mapProductType(order.producttype, child.account.broker, exchange), expiry: order.expiry || order.expirydate, expirydate: order.expirydate || order.expiry, optiontype: order.optiontype, strike: order.strike || order.strikeprice, strikeprice: order.strikeprice || order.strike };
          const contract = require('./instrumentService').resolveContract(params.tradingsymbol, exchange);
          if (contract) { params.tradingsymbol = contract.symbol; params.symboltoken = contract.token; }
          await queue.enqueueOrder(child.account.ownerId, mapping.childId, params, { trackingKey, expectedChildQty: expected, masterOrderId: order.orderid, masterAccountId: masterId });
          } catch (error) { this.addLog({ timestamp: new Date().toISOString(), accountId: mapping.childId, type: 'error', message: 'Copy could not be queued: ' + error.message }); }
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
