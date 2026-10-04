const fs = require('fs');
const path = require('path');
const AngelOneService = require('./services/angelOneService');

async function test() {
  try {
    const configPath = path.join(__dirname, 'config.json');
    if (!fs.existsSync(configPath)) {
      console.error('config.json not found!');
      return;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const user = config.users[0];
    const angelAcc = user.accounts.find(a => a.broker === 'angel_one' && !a.isSimulated);
    
    if (!angelAcc) {
      console.error('No live Angel One account found in config.');
      return;
    }
    
    const service = new AngelOneService(angelAcc, (log) => {
      console.log(`[LogCallback] [${log.type}] ${log.message}`);
    });
    
    console.log('Logging in to Angel One...');
    const loggedIn = await service.login();
    if (!loggedIn) {
      console.error('Login failed.');
      return;
    }
    
    console.log('Login successful! Fetching quote for M&M-EQ (token 2031)...');
    const exchangeGroups = {
      "NSE": ["2031"]
    };
    
    const quote = await service.getMarketQuotes(exchangeGroups);
    console.log('Quote result:', JSON.stringify(quote, null, 2));
  } catch (err) {
    console.error('Error in test:', err);
  }
}

test();
