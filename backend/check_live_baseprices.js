const { Client } = require('ssh2');

const sshConfig = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
  readyTimeout: 30000
};

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connection established.');
  
  const scriptCode = `
const fs = require('fs');
const axios = require('axios');

async function checkServer() {
  try {
    const accounts = ['acc_xb4qfvl', 'acc_t20y89t'];
    for (const acc of accounts) {
      console.log('Fetching portfolio for ' + acc + '...');
      const res = await axios.get('http://127.0.0.1:3000/api/portfolio/' + acc);
      const positions = res.data.positions || [];
      console.log('Positions count:', positions.length);
      positions.forEach(p => {
        if (p.tradingsymbol.includes('23950')) {
          console.log('Account:', acc, 'Symbol:', p.tradingsymbol, 'NetQty:', p.netqty, 'LTP:', p.ltp, 'BuyAvg:', p.buyavgprice, 'SellAvg:', p.sellavgprice);
        }
      });
    }
  } catch (err) {
    console.error('Error fetching portfolio:', err.message);
  }
}

checkServer();
`;

  const remotePath = '/home/tradenterinvest/app/copy-trading-app/backend/check_live_baseprices_vps.js';

  conn.exec(`cat << 'EOF' > ${remotePath}\n${scriptCode}\nEOF\nnode ${remotePath}\nrm -f ${remotePath}`, (err, stream) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', () => {
      console.log('--- VPS SCRIPT OUTPUT START ---');
      console.log(output);
      console.log('--- VPS SCRIPT OUTPUT END ---');
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    });
  });
}).on('error', (err) => {
  console.error(err);
}).connect(sshConfig);
