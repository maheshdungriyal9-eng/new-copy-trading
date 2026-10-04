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
  console.log('SSH connection established. Scanning log for DELIVERY or error...');
  conn.exec('grep -i -E "delivery|error|placeorder|rms" /home/tradenterinvest/.pm2/logs/copy-trading-out.log | tail -n 100', (err, stream) => {
    if (err) {
      console.error('Exec error:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log('--- VPS OUT LOGS START ---');
      console.log(output);
      console.log('--- VPS OUT LOGS END ---');
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
