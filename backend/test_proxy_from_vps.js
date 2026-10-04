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
  console.log('SSH connection established. Running curl test on VPS...');
  conn.exec('curl -v -x http://copytrader:securepass123@34.180.40.255:3128 https://api.ipify.org?format=json', (err, stream) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    let out = '';
    let stderr = '';
    stream.on('close', () => {
      console.log('\n--- CURL OUTPUT ---');
      console.log(out);
      console.log('\n--- STDERR ---');
      console.log(stderr);
      conn.end();
    }).on('data', (data) => {
      out += data.toString();
    }).stderr.on('data', (data) => {
      stderr += data.toString();
    });
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);
