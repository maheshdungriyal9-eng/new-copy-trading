const { Client } = require('ssh2');

const config = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
  readyTimeout: 30000
};

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connection established. Reading remote config...');
  conn.exec('cat /home/tradenterinvest/app/copy-trading-app/backend/config.json', (err, stream) => {
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
