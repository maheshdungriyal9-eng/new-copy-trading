const axios = require('axios');
const fs = require('fs');
const storage = require('./storageService');
const { STOCKS_DATABASE } = require('./stockDb');
const cacheName = 'instruments.json';
let activeDatabase = STOCKS_DATABASE.map(stock => ({ ...stock, exchange: 'NSE', price: 0, lotSize: 1 }));
let refreshing = null;

function expiryCode(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return String(date.getUTCDate()).padStart(2, '0') + ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][date.getUTCMonth()] + String(date.getUTCFullYear()).slice(-2);
}

async function initializeInstruments() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const cache = storage.dataPath(cacheName);
    if (fs.existsSync(cache)) {
      try {
        const cached = storage.readJson(cacheName, []);
        if (Array.isArray(cached) && cached.length) activeDatabase = cached;
        if (Date.now() - fs.statSync(cache).mtimeMs < 6 * 3600000) return activeDatabase;
      } catch (error) { console.error('[Instruments] Invalid cache:', error.message); }
    }
    try {
      const response = await axios.get('https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json', { timeout: 20000 });
      if (!Array.isArray(response.data) || !response.data.length) throw new Error('Invalid instrument master');
      const records = response.data.filter(item => item?.symbol && ['NSE','BSE','NFO','BFO','MCX','CDS'].includes(item.exch_seg)).map(item => ({
        symbol: item.symbol, token: String(item.token), exchange: item.exch_seg, name: item.name,
        underlying: String(item.name).toUpperCase(), expiry: item.expiry || '', expiryCode: expiryCode(item.expiry),
        strike: Number(item.strike) / (item.exch_seg === 'CDS' ? 10000000 : 100),
        optionType: /CE$/.test(item.symbol) ? 'CE' : /PE$/.test(item.symbol) ? 'PE' : '',
        instrumentType: item.instrumenttype, lotSize: Number(item.lotsize || 1),
        tickSize: Number(item.tick_size || 5) / (item.exch_seg === 'CDS' ? 10000000 : 100), price: 0
      }));
      storage.writeJson(cacheName, records);
      activeDatabase = records;
    } catch (error) { console.error('[Instruments] Refresh failed; retaining last valid cache:', error.message); }
    return activeDatabase;
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

function getDatabase() { return activeDatabase; }
function getOptionContracts(underlying) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return activeDatabase.filter(item => item.underlying === underlying && item.optionType && Number.isFinite(Date.parse(item.expiry)) && new Date(item.expiry).toISOString().slice(0, 10) >= today);
}
module.exports = { initializeInstruments, getDatabase, getOptionContracts };
