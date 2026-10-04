const fs = require('fs');
const path = require('path');
const axios = require('axios');
const instrumentService = require('./instrumentService');

const CSV_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const CSV_PATH = require('./storageService').dataPath('api-scrip-master.csv');

// In-memory indexes for fast mapping lookups
const equityMap = {};     // NSE_SBIN -> securityId
const indexMap = {};      // NSE_NIFTY -> securityId
const derivativeMap = {}; // NSE_NIFTY_CE_29300_2026-07-28 -> securityId
const rawTradingSymbolMap = {}; // Maps raw tradingSymbol -> { securityId, exchangeSegment, expiryDate, strike, optionType, instName, lotSize }
const detailsByTokenMap = {}; // Maps unique securityId -> { securityId, exchangeSegment, expiryDate, strike, optionType, instName, tradingSymbol, lotSize }

const MONTHS = { 
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', 
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' 
};

let isInitialized = false;
let lastInitialized = 0;
let initializing = null;
let isDataApiDisabled = false;

// Normalize dates from Dhan CSV to YYYY-MM-DD
function normalizeDate(dateStr) {
  if (!dateStr || dateStr.startsWith('0001')) return '';
  return dateStr.split(' ')[0].trim();
}

// Convert "30JUN26" to "2026-06-30"
function parseAoExpiry(aoDateStr) {
  if (!aoDateStr || aoDateStr.length !== 7) return '';
  const day = aoDateStr.substring(0, 2);
  const monthName = aoDateStr.substring(2, 5).toUpperCase();
  const yearEnd = aoDateStr.substring(5, 7);
  const month = MONTHS[monthName];
  if (!month) return '';
  return `20${yearEnd}-${month}-${day}`;
}

// Download and parse Dhan CSV master list
async function initializeDhanService() {
  isDataApiDisabled = false;
  if (isInitialized && Date.now() - lastInitialized < 6 * 3600000) return true;

  try {
    // 1. Download CSV if it doesn't exist
    if (!fs.existsSync(CSV_PATH) || Date.now() - fs.statSync(CSV_PATH).mtimeMs > 6 * 3600000) {
      console.log('[DhanService] Dhan scrip master CSV not found. Downloading from images.dhan.co...');
      const response = await axios.get(CSV_URL, { timeout: 45000 });
      if (typeof response.data !== 'string' || !response.data.includes('SEM_EXM_EXCH_ID')) throw new Error('Invalid Dhan instrument master');
      fs.writeFileSync(CSV_PATH + '.tmp', response.data, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(CSV_PATH + '.tmp', CSV_PATH);
      console.log('[DhanService] Downloaded and cached Dhan scrip master CSV.');
    } else {
      console.log('[DhanService] Loading Dhan scrip master CSV from cache...');
    }

    // 2. Parse CSV
    const csvData = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = csvData.split('\n');
    for (const index of [equityMap, indexMap, derivativeMap, rawTradingSymbolMap, detailsByTokenMap]) for (const key of Object.keys(index)) delete index[key];
    console.log(`[DhanService] Parsing ${lines.length} Dhan scrip master lines...`);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      const parts = line.split(',');
      if (parts.length < 11) continue;

      const exchange = parts[0].trim();
      const segment = parts[1].trim();
      const secId = parts[2].trim();
      const instName = parts[3].trim();
      const tradingSymbol = parts[5].trim();
      const expiryDate = normalizeDate(parts[8].trim());
      const strike = parts[9].trim();
      const optionType = parts[10].trim();

      if (segment === 'E') {
        // Equity
        equityMap[`${exchange}_${tradingSymbol.replace('-EQ', '')}`] = secId;
      } else if (segment === 'I') {
        // Index
        indexMap[`${exchange}_${tradingSymbol}`] = secId;
      } else if (segment === 'D' || segment === 'M') {
        // Derivatives (F&O) & Commodity
        // Extract underlying symbol (handle hyphenated underlyings like BAJAJ-AUTO)
        const parts = tradingSymbol.split('-');
        const isFut = instName.includes('FUT') || tradingSymbol.includes('FUT');
        let underlying = parts[0];
        if (isFut) {
          if (parts.length >= 3) {
            underlying = parts.slice(0, -2).join('-');
          }
          derivativeMap[`${exchange}_${underlying}_FUT_${expiryDate}`] = secId;
        } else {
          if (parts.length >= 4) {
            underlying = parts.slice(0, -3).join('-');
          }
          const cleanStrike = parseFloat(strike).toString();
          derivativeMap[`${exchange}_${underlying}_${optionType}_${cleanStrike}_${expiryDate}`] = secId;
        }
      }

      let exchangeSegment = '';
      if (segment === 'E') {
        exchangeSegment = `${exchange}_EQ`;
      } else if (segment === 'I') {
        exchangeSegment = 'IDX_I';
      } else if (segment === 'D' || segment === 'M') {
        exchangeSegment = exchange === 'MCX' ? 'MCX_COMM' : `${exchange}_FNO`;
      }

      const lotSizeVal = (segment === 'E' || segment === 'I') ? 1 : (parts[6] ? parseFloat(parts[6].trim()) : 1);

      const detailsObj = {
        securityId: secId,
        exchangeSegment: exchangeSegment,
        expiryDate: expiryDate,
        strike: strike,
        optionType: optionType,
        instName: instName,
        tradingSymbol: tradingSymbol,
        lotSize: lotSizeVal
      };

      rawTradingSymbolMap[exchangeSegment + ':' + tradingSymbol.toUpperCase()] = detailsObj;
      detailsByTokenMap[exchangeSegment + ':' + secId] = detailsObj;
    }

    console.log(`[DhanService] Dhan indexing complete. Indexed ${Object.keys(equityMap).length} equities, ${Object.keys(indexMap).length} indices, ${Object.keys(derivativeMap).length} derivatives.`);
    isInitialized = true;
    lastInitialized = Date.now();
    return true;
  } catch (err) {
    console.error('[DhanService] Failed to initialize Dhan Service:', err.message);
    return false;
  }
}

// Helper: Parse Angel One symbol structure or synthetic symbol
function parseSymbolDetails(symbol, exchangeSegment) {
  if (!symbol) return null;

  const cleanSymbol = symbol.trim().toUpperCase().replace(/\s+/g, '');

  // 1. Check Indices
  if (
    cleanSymbol === 'NIFTY' || cleanSymbol === 'BANKNIFTY' || cleanSymbol === 'SENSEX' || cleanSymbol === 'FINNIFTY' ||
    cleanSymbol === 'NIFTY-EQ' || cleanSymbol === 'BANKNIFTY-EQ' || cleanSymbol === 'SENSEX-EQ' || cleanSymbol === 'FINNIFTY-EQ'
  ) {
    const cleanSym = cleanSymbol.replace('-EQ', '');
    return {
      type: 'IDX',
      underlying: cleanSym,
      exchange: cleanSym === 'SENSEX' ? 'BSE' : 'NSE'
    };
  }

  // 2. Check Equities with -EQ
  if (cleanSymbol.endsWith('-EQ')) {
    return {
      type: 'EQ',
      underlying: cleanSymbol.replace('-EQ', ''),
      exchange: exchangeSegment || 'NSE'
    };
  }

  // 3. Check Derivatives with dashes (synthetic format: NIFTY-25JUN26-24500-CE)
  const parts = cleanSymbol.split('-');
  if (parts.length >= 3) {
    const isFut = parts[parts.length - 1] === 'FUT';
    let underlying = parts[0];
    let expiry = parts[1];
    
    if (isFut) {
      if (parts.length >= 3) {
        underlying = parts.slice(0, -2).join('-');
        expiry = parts[parts.length - 2];
      }
    } else {
      if (parts.length >= 4) {
        underlying = parts.slice(0, -3).join('-');
        expiry = parts[parts.length - 3];
      }
    }

    const commodities = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINI', 'LEAD', 'MENTHAOIL'];
    const isCommodity = commodities.includes(underlying);
    const exchange = isCommodity ? 'MCX' : ['BFO', 'BSE_FNO'].includes(exchangeSegment) || underlying === 'SENSEX' || underlying === 'BANKEX' ? 'BSE' : 'NFO';

    // Parse Expiry Date:
    let aoExpiry = expiry;
    if (expiry.length > 7) {
      const day = expiry.substring(0, 2);
      const month = expiry.substring(2, 5).toUpperCase();
      const year = expiry.substring(expiry.length - 2);
      aoExpiry = `${day}${month}${year}`;
    }

    if (isFut) {
      return {
        type: 'FUT',
        underlying,
        expiry: aoExpiry,
        exchange
      };
    } else {
      const strike = parts[parts.length - 2];
      const optionType = parts[parts.length - 1]; // CE or PE
      return {
        type: 'OPT',
        underlying,
        expiry: aoExpiry,
        strike: parseFloat(strike).toString(),
        optionType,
        exchange
      };
    }
  }

  // 4. Try parsing raw derivative formats (no dashes, e.g. NIFTY25JUN2624500CE)
  const optRegex = /^([A-Z]+)(\d{2}[A-Z]{3}\d{2})(\d+(?:\.\d+)?)(CE|PE)$/;
  const futRegex = /^([A-Z]+)(\d{2}[A-Z]{3}\d{2})FUT$/;

  const optMatch = cleanSymbol.match(optRegex);
  if (optMatch) {
    const underlying = optMatch[1];
    const commodities = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINI', 'LEAD', 'MENTHAOIL'];
    const isCommodity = commodities.includes(underlying);
    const exchange = isCommodity ? 'MCX' : 'NFO';

    const db = instrumentService.getDatabase();
    const stock = db.find(s => s.symbol === cleanSymbol);
    const finalExchange = stock ? stock.exchange : exchange;

    return {
      type: 'OPT',
      underlying,
      expiry: optMatch[2],
      strike: parseFloat(optMatch[3]).toString(),
      optionType: optMatch[4],
      exchange: finalExchange === 'NFO' ? 'NSE' : finalExchange
    };
  }

  const futMatch = cleanSymbol.match(futRegex);
  if (futMatch) {
    const underlying = futMatch[1];
    const commodities = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINI', 'LEAD', 'MENTHAOIL'];
    const isCommodity = commodities.includes(underlying);
    const exchange = isCommodity ? 'MCX' : 'NFO';

    const db = instrumentService.getDatabase();
    const stock = db.find(s => s.symbol === cleanSymbol);
    const finalExchange = stock ? stock.exchange : exchange;

    return {
      type: 'FUT',
      underlying,
      expiry: futMatch[2],
      exchange: finalExchange === 'NFO' ? 'NSE' : finalExchange
    };
  }

  // 5. Fallback: plain equity symbol (e.g. SBIN, RELIANCE)
  if (/^[A-Z0-9\-_]+$/.test(cleanSymbol)) {
    return {
      type: 'EQ',
      underlying: cleanSymbol.replace('-EQ', ''),
      exchange: exchangeSegment || 'NSE'
    };
  }

  return null;
}

// Maps symbol to Dhan securityId and exchangeSegment
function resolveToDhan(symbol, exchangeSegment, token) {
  if (!symbol) return null;
  const cleanSymbol = symbol.trim().toUpperCase().replace(/\s+/g, '');
  
  const segment = normalizeSegment(exchangeSegment, cleanSymbol);
  const tokenMatch = token && detailsByTokenMap[segment + ':' + token];
  if (tokenMatch && tokenMatch.tradingSymbol.toUpperCase() === cleanSymbol) return { securityId: tokenMatch.securityId, exchangeSegment: tokenMatch.exchangeSegment };
  const directMatch = rawTradingSymbolMap[segment + ':' + cleanSymbol];
  if (directMatch) return { securityId: directMatch.securityId, exchangeSegment: directMatch.exchangeSegment };

  const details = parseSymbolDetails(symbol, exchangeSegment);
  if (!details) return null;

  const exchange = details.exchange === 'NFO' ? 'NSE' : details.exchange === 'BFO' ? 'BSE' : details.exchange;

  if (details.type === 'IDX') {
    const key = `${exchange}_${details.underlying}`;
    const dhanId = indexMap[key];
    if (dhanId) {
      return { securityId: dhanId, exchangeSegment: 'IDX_I' };
    }
  } else if (details.type === 'EQ') {
    const key = `${exchange}_${details.underlying}`;
    const dhanId = equityMap[key];
    if (dhanId) {
      return { securityId: dhanId, exchangeSegment: `${exchange}_EQ` };
    }
  } else if (details.type === 'FUT') {
    const expiry = parseAoExpiry(details.expiry);
    const key = `${exchange}_${details.underlying}_FUT_${expiry}`;
    const dhanId = derivativeMap[key];
    if (dhanId) {
      const segment = exchange === 'MCX' ? 'MCX_COMM' : `${exchange}_FNO`;
      return { securityId: dhanId, exchangeSegment: segment };
    }
  } else if (details.type === 'OPT') {
    const expiry = parseAoExpiry(details.expiry);
    const key = `${exchange}_${details.underlying}_${details.optionType}_${details.strike}_${expiry}`;
    const dhanId = derivativeMap[key];
    if (dhanId) {
      const segment = exchange === 'MCX' ? 'MCX_COMM' : `${exchange}_FNO`;
      return { securityId: dhanId, exchangeSegment: segment };
    }
  }

  return null;
}

// Fetch live OHLC quotes from Dhan API for a list of symbols
async function fetchPrices(symbols, credentials) {
  if (isDataApiDisabled) {
    return {};
  }
  if (!isInitialized) {
    const ok = await initializeDhanService();
    if (!ok) return {};
  }

  if (!credentials || !credentials.clientId || !credentials.accessToken) {
    console.error('[DhanService] Missing credentials for Dhan API');
    return {};
  }

  // 1. Resolve and group symbols
  const segmentGroups = {};
  const dhanIdToSymbol = {};

  symbols.forEach(symbol => {
    // Look up in our DB if possible
    const db = instrumentService.getDatabase();
    const stock = db.find(s => s.symbol === symbol);
    const resolved = resolveToDhan(symbol, stock ? stock.exchange : null);
    
    if (resolved) {
      const { securityId, exchangeSegment } = resolved;
      if (!segmentGroups[exchangeSegment]) {
        segmentGroups[exchangeSegment] = [];
      }
      segmentGroups[exchangeSegment].push(parseInt(securityId));
      dhanIdToSymbol[exchangeSegment + ':' + securityId] = symbol;
    } else {
      console.warn(`[DhanService] Could not resolve symbol to Dhan: ${symbol}`);
    }
  });

  if (Object.keys(segmentGroups).length === 0) {
    return {};
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'client-id': credentials.clientId,
      'access-token': credentials.accessToken
    };

    // We call /marketfeed/quote so we get both LTP (last_price) and daily close (close)
    const response = await axios.post(
      'https://api.dhan.co/v2/marketfeed/quote',
      segmentGroups,
      { headers, timeout: 5000 }
    );

    const priceMap = {};
    if (response.data && response.data.status === 'success' && response.data.data) {
      const data = response.data.data;
      
      // Iterate segments
      for (const segment in data) {
        const items = data[segment];
        for (const secId in items) {
          const quote = items[secId];
          const symbol = dhanIdToSymbol[segment + ':' + secId];
          if (symbol && quote.last_price !== undefined) {
            priceMap[symbol] = {
              ltp: parseFloat(quote.last_price),
              prevClose: parseFloat(quote.ohlc?.close ?? quote.close ?? quote.last_price)
            };
          }
        }
      }
    } else {
      console.error('[DhanService] Dhan API responded with error:', response.data);
    }

    return priceMap;
  } catch (err) {
    const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('[DhanService] Error fetching prices from Dhan API:', errorMsg);
    
    // Parse error string to see if data API is not subscribed or unauthorized
    const errorLower = errorMsg.toLowerCase();
    if (
      errorLower.includes('806') || 
      errorLower.includes('808') || 
      errorLower.includes('not subscribed') || 
      errorLower.includes('unauthorized') || 
      errorLower.includes('invalid_authentication') ||
      errorLower.includes('authentication failed')
    ) {
      console.warn('[DhanService] Dhan Data API subscription check failed or token invalid. Disabling Dhan live price fetching to avoid rate-limit blocking.');
      isDataApiDisabled = true;
    }
    return {};
  }
}

function resetDataApiStatus() {
  isDataApiDisabled = false;
  console.log('[DhanService] Reset Dhan Data API status to enabled.');
}

function normalizeSegment(exchange, symbol = '') {
  if (exchange?.includes('_')) return exchange;
  if (['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'].includes(symbol.replace('-EQ', ''))) return 'IDX_I';
  return { NSE: 'NSE_EQ', BSE: 'BSE_EQ', NFO: 'NSE_FNO', NSEFO: 'NSE_FNO', BFO: 'BSE_FNO', BSEFO: 'BSE_FNO', MCX: 'MCX_COMM', CDS: 'NSE_CURRENCY' }[exchange || 'NSE'];
}
function getDhanSymbolDetails(symbol, exchange) {
  if (!symbol) return null;
  const resolved = resolveToDhan(symbol, exchange);
  return resolved ? detailsByTokenMap[resolved.exchangeSegment + ':' + resolved.securityId] || null : null;
}
function getDhanSymbolDetailsByToken(token, exchange) {
  if (!token || !exchange) return null;
  return detailsByTokenMap[normalizeSegment(exchange) + ':' + token] || null;
}
function getDhanLotSize(symbol, exchange) {
  return getDhanSymbolDetails(symbol, exchange)?.lotSize || null;
}

module.exports = {
  initializeDhanService,
  resolveToDhan,
  fetchPrices,
  resetDataApiStatus,
  getDhanSymbolDetails,
  getDhanSymbolDetailsByToken,
  getDhanLotSize
};
