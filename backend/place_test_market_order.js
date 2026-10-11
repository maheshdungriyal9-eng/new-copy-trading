const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 30000
};

const remoteScript = `
const fs = require('fs');
const DhanTradeService = require('./backend/services/dhanTradeService');
const dhanService = require('./backend/services/dhanService');

const config = JSON.parse(fs.readFileSync('backend/config.json', 'utf8'));

// Find Arun Kumar's Dhan account
let dhanAccount = null;
for (const user of config.users) {
  const acc = user.accounts.find(a => a.id === 'acc_t20y89t');
  if (acc) {
    dhanAccount = acc;
    break;
  }
}

if (!dhanAccount) {
  console.log("Arun Kumar's Dhan account not found in config.json");
  process.exit(1);
}

async function run() {
  console.log("Initializing Dhan Service...");
  await dhanService.initializeDhanService();
  
  console.log("Using account: " + dhanAccount.name);
  const service = new DhanTradeService(dhanAccount, (l) => console.log("[DhanLog]", l.message));
  const loggedIn = await service.login();
  if (!loggedIn) {
    console.log("Login failed");
    return;
  }
  
  console.log("Placing test MARKET order for 1 share of IDEA...");
  const params = {
    tradingsymbol: 'IDEA',
    exchange: 'NSE',
    transactiontype: 'BUY',
    quantity: 1,
    ordertype: 'MARKET',
    producttype: 'CNC'
  };
  
  const response = await service.placeOrder(params);
  console.log("Response:", JSON.stringify(response));
  
  if (response.status && response.data && response.data.orderid) {
    const orderId = response.data.orderid;
    console.log("Placed Order ID:", orderId);
    
    // Wait 2 seconds for execution
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log("Fetching order book to find our order...");
    const orders = await service.getOrderBook(true);
    const ourOrder = orders.find(o => o.orderid === orderId);
    if (ourOrder) {
      console.log("\\n--- Placed Order Details in Order Book ---");
      console.log("ID:", ourOrder.orderid);
      console.log("Symbol:", ourOrder.tradingsymbol);
      console.log("OrderType in Book:", ourOrder.ordertype);
      console.log("Status:", ourOrder.status);
      console.log("Quantity:", ourOrder.quantity);
      console.log("Price (limit price):", ourOrder.price);
      console.log("Average Price:", ourOrder.averageprice);
      console.log("ProductType:", ourOrder.producttype);
    } else {
      console.log("Order not found in order book");
    }
  }
}

run().catch(console.error);
`;

conn.on('ready', () => {
  console.log('SSH connection established. Writing test script to VPS...');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    
    const remotePath = '/home/tradenterinvest/app/copy-trading-app/place_test_market_temp.js';
    const stream = sftp.createWriteStream(remotePath);
    
    stream.on('close', () => {
      console.log('Script written. Running script on VPS...');
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node place_test_market_temp.js', (err, execStream) => {
        if (err) {
          console.error(err);
          conn.end();
          return;
        }
        let out = '';
        execStream.on('close', () => {
          console.log('\n--- VPS EXECUTION OUTPUT ---');
          console.log(out);
          
          // Cleanup
          sftp.unlink(remotePath, (err) => {
            if (err) console.error('Failed to delete script:', err);
            console.log('VPS script cleaned up.');
            conn.end();
          });
        }).on('data', (data) => {
          out += data.toString();
        }).stderr.on('data', (data) => {
          console.error('STDERR:', data.toString());
        });
      });
    }).on('error', (writeErr) => {
      console.error('SFTP write error:', writeErr);
      conn.end();
    });
    
    stream.write(remoteScript);
    stream.end();
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);
