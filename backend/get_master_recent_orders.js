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

const config = JSON.parse(fs.readFileSync('backend/config.json', 'utf8'));
const masterAccount = config.users.find(u => u.id === 'usr_default').accounts.find(a => a.id === 'acc_xb4qfvl');

async function run() {
  const service = new DhanTradeService(masterAccount, () => {});
  await service.login();
  const orders = await service.getOrderBook(true);
  
  console.log("Recent 10 orders on Dhan Master account:");
  orders.slice(-10).forEach((o, i) => {
    console.log("\\n--- Order " + (i + 1) + " ---");
    console.log("ID:", o.orderid);
    console.log("Symbol:", o.tradingsymbol);
    console.log("OrderType:", o.ordertype);
    console.log("Transaction:", o.transactiontype);
    console.log("Status:", o.status);
    console.log("Quantity:", o.quantity);
    console.log("Price:", o.price);
    console.log("Average Price:", o.averageprice);
    console.log("UpdateTime:", o.updatetime);
    console.log("Expiry:", o.expiry);
    console.log("OptionType:", o.optiontype);
    console.log("Strike:", o.strike);
  });
}

run().catch(console.error);
`;

conn.on('ready', () => {
  console.log('SSH connection established. Writing script...');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    const remotePath = '/home/tradenterinvest/app/copy-trading-app/get_master_recent_temp.js';
    const stream = sftp.createWriteStream(remotePath);
    
    stream.on('close', () => {
      console.log('Script written. Running...');
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node get_master_recent_temp.js', (err2, stream2) => {
        if (err2) {
          console.error(err2);
          conn.end();
          return;
        }
        let out = '';
        stream2.on('close', () => {
          console.log('\n--- VPS EXECUTION OUTPUT ---');
          console.log(out);
          sftp.unlink(remotePath, (e) => {
            conn.end();
          });
        }).on('data', (d) => {
          out += d.toString();
        }).stderr.on('data', (d) => {
          console.error('STDERR:', d.toString());
        });
      });
    });
    
    stream.write(remoteScript);
    stream.end();
  });
}).on('error', (err) => {
  console.error(err);
}).connect(config);
