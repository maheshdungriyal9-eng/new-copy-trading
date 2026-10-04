const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
  readyTimeout: 20000
};

conn.on('ready', () => {
  console.log('SSH ready. Listing files on VPS...');
  conn.exec('tail -n 20 /home/tradenterinvest/.pm2/logs/copy-trading-out.log; echo "--- ERROR LOGS ---"; tail -n 20 /home/tradenterinvest/.pm2/logs/copy-trading-error.log', (err, stream) => {
    if (err) {
      console.error('Exec error:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log(`find exited with code ${code}`);
      console.log('VPS Directory Structure:');
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
