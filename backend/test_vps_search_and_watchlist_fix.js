const axios = require('axios');

async function verifyFixes() {
  try {
    const baseUrl = 'http://localhost:3000';
    console.log('--- TEST 1: AUTOCOMPLETE SEARCH EXPIRY ---');
    console.log('Searching for "RELIANCE 1300"...');
    const searchRes = await axios.get(`${baseUrl}/api/stocks/search?q=RELIANCE 1300`);
    const searchItems = searchRes.data;
    console.log(`Found ${searchItems.length} search results.`);
    console.log('First 5 search results:');
    console.log(JSON.stringify(searchItems.slice(0, 5), null, 2));

    // Check if expiry is 30JUN26 (since stock option is monthly expiry)
    const hasWeeklyExpiry = searchItems.some(item => item.symbol.includes('25JUN26'));
    const hasMonthlyExpiry = searchItems.some(item => item.symbol.includes('30JUN26'));
    console.log('Contains weekly expiry (25JUN26):', hasWeeklyExpiry);
    console.log('Contains monthly expiry (30JUN26):', hasMonthlyExpiry);
    if (hasMonthlyExpiry && !hasWeeklyExpiry) {
      console.log('SUCCESS: Stock options are generated with correct monthly expiry!');
    } else {
      console.error('FAILED: Stock options still show incorrect weekly expiry.');
    }

    console.log('\n--- TEST 2: ON-DEMAND QUOTE & DEPTH FOR M&M-EQ ---');
    console.log('Querying stock info for "M&M-EQ"...');
    const infoRes = await axios.get(`${baseUrl}/api/stocks/info?symbol=M%26M-EQ`);
    const stockInfo = infoRes.data;
    console.log('M&M-EQ Info Response details:');
    console.log(JSON.stringify(stockInfo, null, 2));

    if (stockInfo && stockInfo.price > 100 && stockInfo.depth && stockInfo.depth.buy.length > 0) {
      console.log('SUCCESS: M&M-EQ price is live and has actual market depth buy/sell orders!');
    } else {
      console.error('FAILED: M&M-EQ price is default or market depth is missing/100 Rs.');
    }

    console.log('\n--- TEST 3: IMMEDIATE WATCHLIST PRICE ---');
    console.log('Adding "M&M-EQ" to watchlist...');
    // Delete first if it's there
    try {
      await axios.delete(`${baseUrl}/api/watchlist/M%26M-EQ?tab=1`);
    } catch(e) {}

    const addRes = await axios.post(`${baseUrl}/api/watchlist`, {
      symbol: 'M&M-EQ',
      tab: '1'
    });
    console.log('Watchlist added response:', addRes.data);

    console.log('Fetching watchlist prices immediately...');
    const pricesRes = await axios.get(`${baseUrl}/api/watchlist/prices`);
    const mmPrice = pricesRes.data.prices['M&M-EQ'];
    console.log('Immediate M&M-EQ price in watchlist:', mmPrice);

    if (mmPrice && mmPrice.ltp > 100 && mmPrice.ltp !== 100.00) {
      console.log('SUCCESS: M&M-EQ price in watchlist was immediately updated to live price!');
    } else {
      console.log('Waiting 1.5 seconds for background fetch...');
      await new Promise(r => setTimeout(r, 1500));
      const pricesRes2 = await axios.get(`${baseUrl}/api/watchlist/prices`);
      const mmPrice2 = pricesRes2.data.prices['M&M-EQ'];
      console.log('M&M-EQ price after 1.5 seconds:', mmPrice2);
      if (mmPrice2 && mmPrice2.ltp > 100) {
        console.log('SUCCESS: Watchlist price warmed up successfully!');
      } else {
        console.error('FAILED: Watchlist price remains at 100 Rs fallback.');
      }
    }
  } catch (err) {
    console.error('Error verifying fixes:', err.message);
  }
}

verifyFixes();
