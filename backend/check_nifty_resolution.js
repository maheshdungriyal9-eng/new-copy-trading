const fs = require('fs');
const path = require('path');

const dhanService = require('./services/dhanService');

async function run() {
  console.log('Initializing Dhan service...');
  await dhanService.initializeDhanService();
  
  const symbol = 'NIFTY-23JUN26-23950-CE';
  const resolved = dhanService.resolveToDhan(symbol);
  console.log('Resolved symbol:', symbol);
  console.log('Resolved details:', resolved);
  
  if (resolved) {
    const details = dhanService.getDhanSymbolDetailsByToken(resolved.securityId);
    console.log('Dhan Master CSV details for token:', resolved.securityId);
    console.log(details);
  }
}

run();
