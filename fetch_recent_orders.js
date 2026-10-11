const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 30000
};

conn.on('ready', () => {
  console.log('SSH connection established. Writing order fetch script on VPS...');
  const scriptContent = `
const fs = require('fs');
const AngelOneService = require('./backend/services/angelOneService');

const config = JSON.parse(fs.readFileSync('backend/config.json', 'utf8'));
const maheshAccount = config.users.find(u => u.id === 'usr_default').accounts.find(a => a.clientCode === 'mhks1001');
const rishabhAccount = config.users.find(u => u.id === 'usr_default').accounts.find(a => a.clientCode === 'MHKS1098');

async function checkOrders(account, label) {
  console.log('--- Checking orders for ' + label + ' (' + account.clientCode + ') ---');
  const service = new AngelOneService(account, (l) => console.log(l.message));
  const loggedIn = await service.login();
  if (!loggedIn) {
    console.log('Login failed for ' + label);
    return;
  }
  try {
    const orders = await service.getOrderBook();
    console.log('Total orders in book:', orders.length);
    const today = new Date().toLocaleDateString();
    const todayOrders = orders.filter(o => {
      // Check if update time or order time matches today
      return o.updatetime && (o.updatetime.includes('18/06/2026') || o.updatetime.includes('2026-06-18') || o.orderstatus === 'rejected' || o.orderstatus === 'validation kicked out');
    });
    console.log('Today/Recent orders:', JSON.stringify(todayOrders, null, 2));
  } catch (err) {
    console.error('Error fetching order book:', err.message);
  }
}

async function run() {
  await checkOrders(maheshAccount, 'MAHESH KUMAR');
  await checkOrders(rishabhAccount, 'RISHABH JAIN');
}

run();
  `;
  
  conn.exec(`cat << 'EOF' > /home/tradenterinvest/app/copy-trading-app/fetch_recent_orders.js\n${scriptContent}\nEOF`, (err, stream) => {
    if (err) {
      console.error('Exec error:', err);
      conn.end();
      return;
    }
    stream.on('close', (code, signal) => {
      console.log('Running fetch_recent_orders.js on VPS...');
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node fetch_recent_orders.js', (err2, stream2) => {
        if (err2) {
          console.error('Exec error:', err2);
          conn.end();
          return;
        }
        let output = '';
        stream2.on('close', (code2, signal2) => {
          console.log('--- VPS RECENT ORDERS START ---');
          console.log(output);
          console.log('--- VPS RECENT ORDERS END ---');
          conn.end();
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          console.error('STDERR:', data.toString());
        });
      });
    }).on('data', (data) => {
      console.log('Write progress:', data.toString());
    });
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);
