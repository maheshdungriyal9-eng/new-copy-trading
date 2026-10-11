const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 20000
};

conn.on('ready', () => {
  console.log('SSH ready. Grepping remote app_v6.js on VPS...');
  conn.exec('grep -n -C 2 "order-qty" /home/tradenterinvest/app/copy-trading-app/frontend/app_v6.js | grep -C 2 "value = "', (err, stream) => {
    if (err) {
      console.error('Exec error:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log(`Command exited with code ${code}`);
      console.log('Output:');
      console.log(output);
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
