const fs = require('fs');
const AngelOneService = require('./backend/services/angelOneService');

// Setup process environment variables or overrides if needed
// Load config
const config = JSON.parse(fs.readFileSync('backend/config.json', 'utf8'));
const maheshAccount = config.users.find(u => u.id === 'usr_default').accounts.find(a => a.clientCode === 'MHKS1098');

console.log('Using account details:', {
  name: maheshAccount.name,
  clientCode: maheshAccount.clientCode,
  broker: maheshAccount.broker,
  isSimulated: maheshAccount.isSimulated
});

const service = new AngelOneService(maheshAccount, (logEntry) => {
  console.log(`[Log] [${logEntry.type}] ${logEntry.message}`, logEntry.details ? JSON.stringify(logEntry.details) : '');
});

async function runTest() {
  console.log('1. Attempting login...');
  const loggedIn = await service.login();
  console.log('Login result:', loggedIn);
  if (!loggedIn) {
    console.error('Login failed. Cannot proceed with trade placement.');
    process.exit(1);
  }

  console.log('2. Attempting to place dummy order for SBIN-EQ (1 share @ Limit Rs 500, NSE)...');
  const orderParams = {
    tradingsymbol: 'SBIN-EQ',
    symboltoken: '3045',
    exchange: 'NSE',
    transactiontype: 'BUY',
    quantity: 1,
    price: 500.0,
    ordertype: 'LIMIT',
    producttype: 'INTRADAY'
  };

  try {
    const orderResponse = await service.placeOrder(orderParams);
    console.log('Order Placement response:', orderResponse);
  } catch (err) {
    console.error('Order Placement encountered an exception:', err);
  }
}

runTest();
