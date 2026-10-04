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
  console.log('SSH connection established. Searching full logs for order details...');
  
  // Read last 200 lines of PM2 log, search for Dhan logs with payload details
  // Note: we can read the file directly and parse if it contains logged JSON objects
  const cmd = `grep -A 2 -B 2 -i "Placing order to Dhan:" /home/tradenterinvest/.pm2/logs/copy-trading-out.log | tail -n 100`;
  
  conn.exec(cmd, (err, stream) => {
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
