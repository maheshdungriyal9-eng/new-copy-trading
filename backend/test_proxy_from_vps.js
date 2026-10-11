const { Client } = require('ssh2');

const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
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
