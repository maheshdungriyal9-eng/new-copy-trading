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
  console.log('SSH connection established. Searching log payload...');
  conn.exec('grep -A 2 -i "Placing order for IDEA" /home/tradenterinvest/.pm2/logs/copy-trading-out.log | tail -n 100', (err, stream) => {
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
