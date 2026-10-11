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
  console.log('SSH connection established. Executing get_motilal_orders.js...');
  conn.exec('cd /home/tradenterinvest/app/copy-trading-app/backend && node get_motilal_orders.js', (err, stream) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    let output = '';
    let stderr = '';
    stream.on('close', (code, signal) => {
      console.log('--- STDOUT ---');
      console.log(output);
      console.log('--- STDERR ---');
      console.log(stderr);
      console.log(`Exit code: ${code}`);
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    });
    
    stream.stderr.on('data', (data) => {
      stderr += data.toString();
    });
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);
