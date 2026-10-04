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
