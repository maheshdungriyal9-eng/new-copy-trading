const { Client } = require('ssh2');

const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 30000
};

const conn = new Client();

const remoteScript = `
const fs = require('fs');
const axios = require('./backend/node_modules/axios');
const DhanTradeService = require('./backend/services/dhanTradeService');

const config = JSON.parse(fs.readFileSync('backend/config.json', 'utf8'));

// Find the Dhan child account
let dhanAccount = null;
for (const user of config.users) {
  const acc = user.accounts.find(a => a.broker === 'dhan' && a.type === 'child');
  if (acc) {
    dhanAccount = acc;
    break;
  }
}

if (!dhanAccount) {
  console.log("No master Dhan account found in config.json");
  process.exit(1);
}

async function run() {
  console.log("Found Dhan account: " + dhanAccount.name + " (" + dhanAccount.clientCode + ")");
  const service = new DhanTradeService(dhanAccount, (l) => console.log("[DhanLog]", l.message));
  const loggedIn = await service.login();
  if (!loggedIn) {
    console.log("Login failed");
    return;
  }
  
  console.log("Fetching order book with query parameter...");
  const headers = service.getHeaders();
  const response = await axios.get('https://api.dhan.co/v2/orders?_t=' + Date.now(), service.getConfig(headers));
  const orders = response.data;
  console.log("Total orders in Dhan book:", orders.length);
  
  console.log("Nifty 24550 CE child orders in book:");
  orders.forEach((o) => {
    if (o.tradingSymbol && o.tradingSymbol.includes("24550")) {
      console.log(JSON.stringify(o, null, 2));
    }
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
    
    const remotePath = '/home/tradenterinvest/app/copy-trading-app/get_dhan_orders_temp.js';
    const stream = sftp.createWriteStream(remotePath);
    
    stream.on('close', () => {
      console.log('Script written. Running script on VPS...');
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node get_dhan_orders_temp.js', (err, execStream) => {
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
