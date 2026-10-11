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
  console.log('SSH connection established. Searching for order logs...');
  // Grep for placeOrder, or any error/success related to placing orders in both log files
  conn.exec('grep -i -C 5 -E "placeOrder|copying|replicate|trigger|fail|error|success|order" /home/tradenterinvest/.pm2/logs/copy-trading-out.log | tail -n 150', (err, stream) => {
    if (err) {
      console.error('Exec error:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log('--- VPS ORDER LOGS START ---');
      console.log(output);
      console.log('--- VPS ORDER LOGS END ---');
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    }).stderr.on('data', (data) => {
      console.error('STDERR:', data.toString());
    });
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);
