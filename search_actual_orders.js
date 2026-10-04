const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
  readyTimeout: 30000
};

conn.on('ready', () => {
  console.log('SSH connection established. Searching for actual order execution logs...');
  // Grep for order-related messages but exclude "Fetch market quotes"
  const cmd = `grep -i -E "execute|placeOrder|order|trade|fail|success" /home/tradenterinvest/.pm2/logs/copy-trading-out.log | grep -v "Fetch market quotes failed" | tail -n 150`;
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('Exec error:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log('--- VPS FILTERED ORDER LOGS START ---');
      console.log(output);
      console.log('--- VPS FILTERED ORDER LOGS END ---');
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
