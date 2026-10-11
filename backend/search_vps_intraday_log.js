const { Client } = require('ssh2');

const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 20000
};

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH connection established. Searching VPS logs for product types...');
  // Grep for "Placing order" in pm2 log files (showing last 20 matching occurrences with context)
  conn.exec('grep -i -C 3 "Placing order" /home/tradenterinvest/.pm2/logs/copy-trading-out.log | tail -n 100', (err, stream) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log(output);
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    });
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);
