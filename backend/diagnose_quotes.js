const copyEngine = require('./services/copyTradingEngine');
const config = require('./config.json');

// Initialize both live Angel One services
let services = [];
config.users.forEach(user => {
  user.accounts.forEach(acc => {
    if (acc.broker === 'angel_one' && !acc.isSimulated) {
      services.push(copyEngine.initializeService(acc));
    }
  });
});

async function runDiagnostics() {
  for (const service of services) {
    console.log(`\n==================================================`);
    console.log(`Diagnosing Account: ${service.account.name} (Code: ${service.account.clientCode})`);
    console.log(`==================================================`);
    
    const loggedIn = await service.login();
    if (!loggedIn) {
      console.log('Login failed for this account');
      continue;
    }
    
    console.log('Logged in. Querying market quotes...');
    const exchangeGroups = {
      'NSE': ['99926000', '99926009', '3045', '5900', '12513'], // Nifty, Nifty Bank, SBIN, SBI Life, Axis Bank
      'BSE': ['99919000'] // Sensex
    };
    
    try {
      const quoteData = await service.getMarketQuotes(exchangeGroups);
      if (quoteData && quoteData.fetched) {
        console.log('--- FETCHED SYMBOLS ---');
        quoteData.fetched.forEach(item => {
          console.log(`Symbol: ${item.tradingSymbol} (${item.exchange}), Token: ${item.symbolToken}, LTP: ${item.ltp}, NetChange: ${item.netChange}`);
        });
      }
      if (quoteData && quoteData.unfetched) {
        console.log('--- UNFETCHED SYMBOLS ---');
        quoteData.unfetched.forEach(item => {
          console.log(`Token: ${item.symbolToken} (${item.exchange}), Message: ${item.message || 'Error'}`);
        });
      }
    } catch (e) {
      console.error('Quotes Error:', e.message);
    }
  }
  process.exit(0);
}

runDiagnostics();
