const crypto = require('crypto');
const configService = require('./configService');
const validation = require('./validationService');

class SimulatedPortfolioManager {
  constructor(options = {}) {
    this.persist = options.persist || ((account, state) => configService.updateAccount(account.id, stored => { stored.simState = state; stored.balance = state.balance; }));
    this.price = options.price || (symbol => {
      const updated = global.lastLiveUpdate?.[symbol];
      return updated && Date.now() - updated < 60000 ? Number(global.basePrices?.[symbol]) : null;
    });
  }

  state(account) {
    if (!account.isSimulated) validation.reject('Paper operations require a simulated account');
    return structuredClone(account.simState || { balance: Number(account.balance ?? 1000000), orders: [], positions: [], holdings: [], closedTrades: [] });
  }

  commit(account, state) {
    this.persist(account, state);
    account.simState = state;
    account.balance = state.balance;
  }

  available(state, excludedOrder) {
    const shortCollateral = state.positions.reduce((sum, position) => sum + (position.netqty < 0 ? Math.abs(position.netqty) * position.buyavgprice * 2 : 0), 0);
    const pending = state.orders.filter(order => order.status === 'pending' && order.orderid !== excludedOrder && order.transactiontype === 'BUY').reduce((sum, order) => sum + Number(order.quantity) * Number(order.price), 0);
    return state.balance - shortCollateral - pending;
  }

  fill(state, order, price) {
    const quantity = Number(order.quantity);
    const side = order.transactiontype;
    const delivery = ['DELIVERY', 'CNC'].includes(order.producttype);
    const collection = delivery ? state.holdings : state.positions;
    let position = collection.find(item => item.tradingsymbol === order.tradingsymbol && item.exchange === order.exchange && (delivery || item.producttype === order.producttype));
    const oldQuantity = position ? Number(delivery ? position.quantity : position.netqty) : 0;
    const average = position ? Number(delivery ? position.averageprice : position.buyavgprice) : 0;
    const delta = side === 'BUY' ? quantity : -quantity;
    if (order.reduceOnly && (!oldQuantity || quantity > Math.abs(oldQuantity) || Math.sign(delta) === Math.sign(oldQuantity))) throw new Error('Exit exceeds the remaining paper position');
    if (delivery && oldQuantity + delta < 0) throw new Error('Insufficient paper holdings');
    if (side === 'BUY' && oldQuantity >= 0 && this.available(state, order.orderid) < quantity * price) throw new Error('Insufficient paper funds');
    const openingShort = Math.max(0, -(oldQuantity + delta)) - Math.max(0, -oldQuantity);
    if (!delivery && openingShort > 0 && this.available(state, order.orderid) < openingShort * price) throw new Error('Insufficient short collateral');
    const closing = oldQuantity && Math.sign(oldQuantity) !== Math.sign(delta) ? Math.min(Math.abs(oldQuantity), quantity) : 0;
    if (closing) state.closedTrades.unshift({
      tradingsymbol: order.tradingsymbol, exchange: order.exchange, producttype: order.producttype, quantity: closing,
      buyPrice: oldQuantity > 0 ? average : price, sellPrice: oldQuantity > 0 ? price : average,
      pnl: Number(((price - average) * closing * Math.sign(oldQuantity)).toFixed(2)), timestamp: new Date().toISOString()
    });
    state.balance = Number((state.balance - delta * price).toFixed(2));
    const newQuantity = oldQuantity + delta;
    let newAverage = average;
    if (!oldQuantity || Math.sign(newQuantity) !== Math.sign(oldQuantity)) newAverage = price;
    else if (Math.sign(delta) === Math.sign(oldQuantity)) newAverage = (Math.abs(oldQuantity) * average + quantity * price) / Math.abs(newQuantity);
    if (!newQuantity) {
      const index = collection.indexOf(position);
      if (index >= 0) collection.splice(index, 1);
    } else {
      if (!position) { position = { tradingsymbol: order.tradingsymbol, exchange: order.exchange, symboltoken: order.symboltoken, producttype: order.producttype }; collection.push(position); }
      if (delivery) { position.quantity = newQuantity; position.averageprice = newAverage; }
      else { position.netqty = newQuantity; position.buyavgprice = newAverage; }
    }
    Object.assign(order, { status: 'executed', orderstatus: 'complete', filledshares: String(quantity), unfilledshares: '0', averageprice: String(price), updatetime: new Date().toISOString() });
  }

  settle(account) {
    const state = this.state(account);
    let changed = false;
    for (const order of state.orders.filter(entry => entry.status === 'pending')) {
      const price = this.price(order.tradingsymbol);
      if (!(price > 0)) continue;
      if (order.transactiontype === 'BUY' ? price > Number(order.price) : price < Number(order.price)) continue;
      try { this.fill(state, order, price); }
      catch (error) { Object.assign(order, { status: 'rejected', orderstatus: 'rejected', message: error.message }); }
      changed = true;
    }
    if (changed) this.commit(account, state);
    return state;
  }

  async getFunds(account) {
    const state = this.settle(account);
    const availableCash = this.available(state);
    const invested = state.positions.reduce((sum, position) => sum + Math.abs(position.netqty) * position.buyavgprice, 0);
    return { availableCash: Number(availableCash.toFixed(2)), utilized: Number(invested.toFixed(2)), margin: Number(availableCash.toFixed(2)) };
  }

  async getHolding(account) {
    return this.settle(account).holdings.map(holding => {
      const ltp = this.price(holding.tradingsymbol) || holding.averageprice;
      const profitandloss = (ltp - holding.averageprice) * holding.quantity;
      return { ...holding, ltp, profitandloss, pnlpercentage: holding.averageprice ? (ltp / holding.averageprice - 1) * 100 : 0 };
    });
  }

  async getPosition(account) {
    return this.settle(account).positions.map(position => {
      const ltp = this.price(position.tradingsymbol) || position.buyavgprice;
      return { ...position, ltp, netvalue: (ltp - position.buyavgprice) * position.netqty };
    });
  }

  async getOrderBook(account) { return this.settle(account).orders; }

  async placeOrder(account, input) {
    const params = validation.trade(input);
    const state = this.settle(account);
    const duplicate = params.correlationId && state.orders.find(order => order.correlationId === params.correlationId);
    if (duplicate) return { status: true, data: { orderid: duplicate.orderid } };
    const price = this.price(params.tradingsymbol);
    if (params.ordertype === 'MARKET' && !(price > 0)) throw new Error('A fresh market quote is required for a paper market order');
    const order = {
      ...params, orderid: 'SIM_' + crypto.randomUUID(), quantity: String(params.quantity), price: String(params.price),
      status: 'pending', orderstatus: 'pending', filledshares: '0', unfilledshares: String(params.quantity), averageprice: '0',
      updatetime: new Date().toISOString(), correlationId: params.correlationId || params.clientOrderId || null
    };
    if (params.transactiontype === 'BUY' && params.ordertype === 'LIMIT' && this.available(state) < params.quantity * params.price) throw new Error('Insufficient paper funds');
    if (params.ordertype === 'MARKET' || (price > 0 && (params.transactiontype === 'BUY' ? price <= params.price : price >= params.price))) this.fill(state, order, price);
    state.orders.unshift(order);
    this.commit(account, state);
    return { status: true, message: 'SUCCESS', data: { orderid: order.orderid } };
  }

  async modifyOrder(account, params) {
    const state = this.settle(account);
    const order = state.orders.find(entry => entry.orderid === params.orderid);
    if (!order || order.status !== 'pending') throw new Error('Only a pending paper order can be modified');
    const updated = validation.trade({ ...order, ...params });
    if (updated.transactiontype === 'BUY' && this.available(state, order.orderid) < updated.quantity * updated.price) throw new Error('Insufficient paper funds');
    Object.assign(order, updated, { quantity: String(updated.quantity), price: String(updated.price) });
    const price = this.price(order.tradingsymbol);
    if (updated.ordertype === 'MARKET' && !(price > 0)) throw new Error('A fresh market quote is required');
    if (price > 0 && (updated.ordertype === 'MARKET' || (order.transactiontype === 'BUY' ? price <= updated.price : price >= updated.price))) this.fill(state, order, price);
    this.commit(account, state);
    return { status: true, message: 'SUCCESS' };
  }

  async cancelOrder(account, orderId) {
    const state = this.settle(account);
    const order = state.orders.find(entry => entry.orderid === orderId);
    if (!order || order.status !== 'pending') throw new Error('Only a pending paper order can be cancelled');
    Object.assign(order, { status: 'cancelled', orderstatus: 'cancelled', updatetime: new Date().toISOString() });
    this.commit(account, state);
    return { status: true, message: 'SUCCESS' };
  }

  recharge(account, amount) {
    const balance = Number(amount);
    if (!Number.isFinite(balance) || balance < 0) validation.reject('Invalid paper balance');
    const state = this.state(account);
    state.balance = balance;
    if (this.available(state) < 0) validation.reject('Balance cannot be less than reserved collateral');
    this.commit(account, state);
    return balance;
  }

  getPnlReport(account) { return this.state(account).closedTrades; }
}
module.exports = new SimulatedPortfolioManager();
module.exports.SimulatedPortfolioManager = SimulatedPortfolioManager;
