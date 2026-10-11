const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 30000
};

conn.on('ready', () => {
  console.log('SSH connection established. Reading remote logs...');
  conn.exec('tail -n 100 /home/tradenterinvest/.pm2/logs/copy-trading-out.log', (err, stream) => {
    if (err) {
      console.error('Exec error:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log('--- VPS OUT LOGS (LAST 100 LINES) ---');
      console.log(output);
      console.log('--- END ---');
      
      // Now read error logs
      conn.exec('tail -n 50 /home/tradenterinvest/.pm2/logs/copy-trading-error.log', (err2, stream2) => {
        if (err2) {
          console.error(err2);
          conn.end();
          return;
        }
        let errOutput = '';
        stream2.on('close', () => {
          console.log('--- VPS ERROR LOGS (LAST 50 LINES) ---');
          console.log(errOutput);
          console.log('--- END ---');
          conn.end();
        }).on('data', data => errOutput += data.toString());
      });
      
    }).on('data', (data) => {
      output += data.toString();
    }).stderr.on('data', (data) => {
      console.error('STDERR:', data.toString());
    });
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);
