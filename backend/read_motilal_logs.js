const { Client } = require('ssh2');

const config = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
  readyTimeout: 20000
};

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH connection established. Searching VPS logs for Motilal...');
  conn.exec('grep -i "Motilal" /home/tradenterinvest/.pm2/logs/copy-trading-out.log | tail -n 100; echo "--- ERRORS ---"; grep -i "Motilal" /home/tradenterinvest/.pm2/logs/copy-trading-error.log | tail -n 100', (err, stream) => {
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
