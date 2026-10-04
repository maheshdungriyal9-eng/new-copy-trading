const fs = require('fs');
const path = require('path');
const MotilalService = require('./services/motilalService');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const motilalAcc = config.users[0].accounts.find(a => a.broker === 'motilal');

if (!motilalAcc) {
  console.error('Motilal account not found in config');
  process.exit(1);
}

const service = new MotilalService(motilalAcc, console.log);

async function run() {
  console.log('Logging in to Motilal Oswal...');
  const success = await service.login();
  if (!success) {
    console.error('Login failed');
    process.exit(1);
  }
  
  console.log('Fetching order book...');
  const orders = await service.getOrderBook(true);
  console.log(`Successfully fetched ${orders.length} orders.`);
  if (orders.length > 0) {
    console.log('Raw sample order keys & values:');
    console.log(JSON.stringify(orders[0], null, 2));
  } else {
    console.log('Order book is empty.');
  }
}

run().catch(console.error);
