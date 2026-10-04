const fs = require('fs');
const path = require('path');
const AngelOneService = require('./services/angelOneService');
const instrumentService = require('./services/instrumentService');

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
    
    console.log('Using live Angel One account:', angelAcc.clientCode);
    
    // Force delete cache file
    const cacheFile = path.join(__dirname, 'services', 'angelOneInstruments.json');
    if (fs.existsSync(cacheFile)) {
      console.log('Force deleting cache file:', cacheFile);
      fs.unlinkSync(cacheFile);
    }
    
    // Initialize instruments database
    console.log('Initializing instruments...');
    await instrumentService.initializeInstruments();
    const db = instrumentService.getDatabase();
    console.log('Total instruments loaded:', db.length);
    
    // Find RELIANCE NFO instruments
    const relNfos = db.filter(item => item.symbol.startsWith('RELIANCE') && item.exchange === 'NFO');
    console.log('Total RELIANCE NFO instruments in db:', relNfos.length);
    if (relNfos.length > 0) {
      console.log('First 5 RELIANCE NFO:', relNfos.slice(0, 5));
    }
    
    const relOpt = db.find(item => item.symbol.startsWith('RELIANCE') && item.exchange === 'NFO' && item.symbol.includes('CE'));
    if (!relOpt) {
      console.error('No RELIANCE CE options found in instruments database.');
      // Let's print some other NFO instruments that start with R
      const rNfos = db.filter(item => item.symbol.startsWith('R') && item.exchange === 'NFO');
      console.log('First 5 NFO starting with R:', rNfos.slice(0, 5));
      return;
    }
    
    console.log('Found RELIANCE CE option:', relOpt);
    
    const service = new AngelOneService(angelAcc, (log) => {
      console.log(`[LogCallback] [${log.type}] ${log.message}`);
    });
    
    console.log('Logging in to Angel One...');
    const loggedIn = await service.login();
    if (!loggedIn) {
      console.error('Login failed.');
      return;
    }
    
    console.log('Login successful! Fetching quote for token:', relOpt.token);
    const exchangeGroups = {
      "NFO": [relOpt.token]
    };
    
    const quote = await service.getMarketQuotes(exchangeGroups);
    console.log('Quote result:', JSON.stringify(quote, null, 2));
    
  } catch (err) {
    console.error('Error in test:', err);
  }
}

test();
