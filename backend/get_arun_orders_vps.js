const { Client } = require('ssh2');

const config = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
  readyTimeout: 30000
};

const conn = new Client();

const remoteScript = `
const fs = require('fs');
const DhanTradeService = require('./backend/services/dhanTradeService');

const config = JSON.parse(fs.readFileSync('backend/config.json', 'utf8'));

// Find Arun Kumar's Dhan account (id: acc_t20y89t)
let dhanAccount = null;
for (const user of config.users) {
  const acc = user.accounts.find(a => a.id === 'acc_t20y89t');
  if (acc) {
    dhanAccount = acc;
    break;
  }
}

if (!dhanAccount) {
  console.log("Arun Kumar's Dhan account acc_t20y89t not found in config.json");
  process.exit(1);
}

async function run() {
  console.log("Found Arun Kumar's account: " + dhanAccount.name + " (" + dhanAccount.clientCode + ")");
  const service = new DhanTradeService(dhanAccount, (l) => console.log("[DhanLog]", l.message));
  const loggedIn = await service.login();
  if (!loggedIn) {
    console.log("Login failed");
    return;
  }
  
  console.log("Fetching order book...");
  const orders = await service.getOrderBook(true);
  console.log("Total orders in Dhan book:", orders.length);
  
  console.log("Recent 10 orders:");
  orders.slice(-10).forEach((o, i) => {
    console.log("\\n--- Order " + (i + 1) + " ---");
    console.log("ID:", o.orderid);
    console.log("Symbol:", o.tradingsymbol);
    console.log("OrderType (from Dhan API):", o.ordertype);
    console.log("Transaction:", o.transactiontype);
    console.log("Status:", o.status);
    console.log("Quantity:", o.quantity);
    console.log("Price:", o.price);
    console.log("Average Price:", o.averageprice);
    console.log("UpdateTime:", o.updatetime);
    console.log("ProductType:", o.producttype);
  });
}

run().catch(console.error);
`;

conn.on('ready', () => {
  console.log('SSH connection established. Writing script to VPS...');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    
    const remotePath = '/home/tradenterinvest/app/copy-trading-app/get_arun_orders_temp.js';
    const stream = sftp.createWriteStream(remotePath);
    
    stream.on('close', () => {
      console.log('Script written. Running script on VPS...');
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node get_arun_orders_temp.js', (err, execStream) => {
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
