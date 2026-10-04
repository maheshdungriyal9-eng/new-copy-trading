const fs = require('fs');
const path = require('path');
const instrumentService = require('./services/instrumentService');

async function check() {
  await instrumentService.initializeInstruments();
  const db = instrumentService.getDatabase();
  
  // Find all RELIANCE NFO options
  const relOptions = db.filter(item => 
    item.symbol.startsWith('RELIANCE') && 
    item.exchange === 'NFO' && 
    item.symbol.includes('30JUN26')
  );
  
  console.log('Total RELIANCE NFO options for 30JUN26:', relOptions.length);
  // Sort by symbol
  relOptions.sort((a,b) => a.symbol.localeCompare(b.symbol));
  
  console.log('RELIANCE options for 30JUN26:');
  relOptions.forEach(opt => {
    // Extract strike price from symbol
    // e.g. RELIANCE30JUN261300CE -> strike 1300
    console.log(`- Symbol: ${opt.symbol}, Token: ${opt.token}, Name: ${opt.name}`);
  });
}

check();
