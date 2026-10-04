const axios = require('axios');

/**
 * Fetch real-time price and previous close from Yahoo Finance for a single NSE stock
 */
async function fetchYahooPrice(symbol) {
  try {
    // Map Symbol-EQ or MCX commodity symbol to Yahoo Finance symbol
    let yahooSymbol = symbol.replace('-EQ', '') + '.NS';
    let multiplier = 1;
    
    if (symbol.includes('CRUDEOIL')) {
      yahooSymbol = 'CL=F';
      multiplier = 83.5;
    } else if (symbol.includes('GOLD')) {
      yahooSymbol = 'GC=F';
      multiplier = 26.845;
    } else if (symbol.includes('SILVER')) {
      yahooSymbol = 'SI=F';
      multiplier = 2684.5;
    } else if (symbol.includes('NATURALGAS')) {
      yahooSymbol = 'NG=F';
      multiplier = 83.5 * 10;
    } else if (symbol.includes('COPPER')) {
      yahooSymbol = 'HG=F';
      multiplier = 184;
    } else if (symbol === 'NIFTY-EQ') {
      yahooSymbol = '%5ENSEI';
    } else if (symbol === 'SENSEX-EQ') {
      yahooSymbol = '%5EBSESN';
    } else if (symbol === 'BANKNIFTY-EQ') {
      yahooSymbol = '%5ENSEBANK';
    }

    const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 3000
    });

    const result = response.data?.chart?.result?.[0];
    if (!result || !result.meta) {
      throw new Error('Invalid response structure from Yahoo Finance');
    }

    const meta = result.meta;
    const rawLtp = meta.regularMarketPrice;
    const rawPrevClose = meta.previousClose || meta.chartPreviousClose || rawLtp;
    
    const quote = result.indicators?.quote?.[0] || {};
    const rawOpen = (quote.open ? quote.open.find(v => v !== null) : null) || rawPrevClose;
    const rawHigh = meta.regularMarketDayHigh || rawLtp;
    const rawLow = meta.regularMarketDayLow || rawLtp;
    
    const ltp = rawLtp * multiplier;
    const prevClose = rawPrevClose * multiplier;
    const open = rawOpen * multiplier;
    const high = rawHigh * multiplier;
    const low = rawLow * multiplier;

    return {
      ltp: parseFloat(ltp.toFixed(2)),
      prevClose: parseFloat(prevClose.toFixed(2)),
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      change: ltp > prevClose ? 'up' : (ltp < prevClose ? 'down' : 'flat')
    };
  } catch (error) {
    console.error(`Error fetching Yahoo price for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Fetch real-time prices for a list of symbols in parallel
 */
async function fetchPricesForSymbols(symbols) {
  const pricePromises = symbols.map(symbol => 
    fetchYahooPrice(symbol).then(data => ({ symbol, data }))
  );
  
  const results = await Promise.all(pricePromises);
  const priceMap = {};
  
  results.forEach(({ symbol, data }) => {
    if (data) {
      priceMap[symbol] = data;
    }
  });
  
  return priceMap;
}

module.exports = {
  fetchYahooPrice,
  fetchPricesForSymbols
};
