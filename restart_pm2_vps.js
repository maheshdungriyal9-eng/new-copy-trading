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
  console.log('SSH connection established. Restarting copy-trading on PM2...');
  conn.exec('pm2 restart copy-trading', (err, stream) => {
    if (err) {
      console.error('PM2 restart error:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log(`PM2 restart command completed with code ${code}.`);
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
