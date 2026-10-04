const axios = require('axios');

async function checkWatchlistPrices() {
  try {
    const baseUrl = 'http://localhost:3000';
    console.log('1. Adding RELIANCE-30JUN26-1300-CE to watchlist...');
    
    // Add to watchlist
    const addRes = await axios.post(`${baseUrl}/api/watchlist`, {
      symbol: 'RELIANCE-30JUN26-1300-CE',
      tab: '1'
    });
    console.log('Add watchlist response:', addRes.data);

    console.log('2. Waiting 6 seconds for background quote fetching...');
    await new Promise(resolve => setTimeout(resolve, 6000));

    console.log('3. Fetching watchlist prices...');
    const pricesRes = await axios.get(`${baseUrl}/api/watchlist/prices`);
    console.log('Watchlist prices response:', JSON.stringify(pricesRes.data, null, 2));

    // Specifically print price for RELIANCE-30JUN26-1300-CE
    const optPrice = pricesRes.data.prices['RELIANCE-30JUN26-1300-CE'];
    console.log('\n--- TARGET OPTION PRICE RESULT ---');
    console.log('RELIANCE-30JUN26-1300-CE price details:', optPrice);
    
    if (optPrice && optPrice.ltp > 0.05 && optPrice.ltp !== 100) {
      console.log('SUCCESS: Option price is live and updated from Angel One!');
    } else {
      console.error('FAILED: Option price is still at fallback/default value.');
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkWatchlistPrices();
