const exchanges = new Set(['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS']);
const products = new Set(['INTRADAY', 'DELIVERY', 'CNC', 'MARGIN', 'MTF', 'CARRYFORWARD', 'MIS', 'NORMAL', 'VALUEPLUS']);

function reject(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function symbol(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9&._ -]{1,100}$/.test(value)) reject('Invalid instrument symbol');
  return value.trim().toUpperCase();
}

function positiveInteger(value, label = 'Quantity') {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) reject(`${label} must be a positive integer`);
  return number;
}

function trade(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) reject('Invalid order');
  const result = { ...params };
  result.tradingsymbol = symbol(params.tradingsymbol);
  result.quantity = positiveInteger(params.quantity);
  result.exchange = String(params.exchange || '').toUpperCase().replace('NSEFO', 'NFO').replace('BSEFO', 'BFO');
  result.transactiontype = String(params.transactiontype || '').toUpperCase();
  result.ordertype = String(params.ordertype || 'MARKET').toUpperCase();
  result.producttype = String(params.producttype || 'INTRADAY').toUpperCase();
  result.price = Number(params.price || 0);
  if (!exchanges.has(result.exchange)) reject('Unsupported exchange');
  if (!['BUY', 'SELL'].includes(result.transactiontype)) reject('Invalid order side');
  if (!['MARKET', 'LIMIT'].includes(result.ordertype)) reject('Only MARKET and LIMIT orders are supported');
  if (!products.has(result.producttype)) reject('Unsupported product type');
  if (!Number.isFinite(result.price) || result.price < 0 || (result.ordertype === 'LIMIT' && result.price <= 0)) reject('Invalid limit price');
  if (params.reduceOnly !== undefined && typeof params.reduceOnly !== 'boolean') reject('Invalid exit order flag');
  return result;
}

function mappings(value, accountIds) {
  if (!Array.isArray(value) || value.length > 200) reject('Mappings must be an array of at most 200 entries');
  const links = new Set();
  const graph = new Map();
  const result = value.map(mapping => {
    if (!mapping || !accountIds.includes(mapping.masterId) || !accountIds.includes(mapping.childId)) reject('Mapping accounts must belong to this user');
    if (mapping.masterId === mapping.childId) reject('An account cannot copy itself');
    const multiplier = Number(mapping.multiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) reject('Multiplier must be greater than zero and at most 100');
    const key = `${mapping.masterId}:${mapping.childId}`;
    if (links.has(key)) reject('Duplicate mapping');
    links.add(key);
    if (mapping.active !== false) graph.set(mapping.masterId, [...(graph.get(mapping.masterId) || []), mapping.childId]);
    return { masterId: mapping.masterId, childId: mapping.childId, multiplier, active: mapping.active !== false };
  });
  function visit(accountId, visiting, visited) {
    if (visiting.has(accountId)) reject('Copy mapping cycles are not allowed');
    if (visited.has(accountId)) return;
    visiting.add(accountId);
    for (const childId of graph.get(accountId) || []) visit(childId, visiting, visited);
    visiting.delete(accountId);
    visited.add(accountId);
  }
  const visited = new Set();
  for (const accountId of graph.keys()) visit(accountId, new Set(), visited);
  return result;
}

module.exports = { reject, symbol, positiveInteger, trade, mappings };
