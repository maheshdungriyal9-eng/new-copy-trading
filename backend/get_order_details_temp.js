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
const DhanTradeService = require('./backend/services/dhanTradeService');

const config = JSON.parse(fs.readFileSync('backend/config.json', 'utf8'));
let dhanAccount = null;
for (const user of config.users) {
  const acc = user.accounts.find(a => a.broker === 'dhan');
  if (acc) {
    dhanAccount = acc;
    break;
  }
}

async function run() {
  const service = new DhanTradeService(dhanAccount);
  await service.login();
  const orders = await service.getOrderBook(true);
  const targetOrder = orders.find(o => o.orderid === '34126061978906');
  if (targetOrder) {
    console.log("FOUND ORDER DETAILS:", JSON.stringify(targetOrder, null, 2));
  } else {
    console.log("ORDER NOT FOUND IN Dhan book");
  }
}
run().catch(console.error);
`;

conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    const remotePath = '/home/tradenterinvest/app/copy-trading-app/get_order_details.js';
    const stream = sftp.createWriteStream(remotePath);
    stream.on('close', () => {
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node get_order_details.js', (err, execStream) => {
        let out = '';
        execStream.on('close', () => {
          console.log(out);
          sftp.unlink(remotePath, () => {
            conn.end();
          });
        }).on('data', (data) => {
          out += data.toString();
        });
      });
    }).write(remoteScript);
    stream.end();
  });
}).connect(config);
