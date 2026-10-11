const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();
const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 30000
};

const localScriptContent = fs.readFileSync('simulate_place_order.js', 'utf8');

conn.on('ready', () => {
  console.log('SSH connection established. Writing test script on VPS...');
  // Write the script content on the VPS
  conn.exec(`cat << 'EOF' > /home/tradenterinvest/app/copy-trading-app/simulate_place_order.js\n${localScriptContent}\nEOF`, (err, stream) => {
    if (err) {
      console.error('Exec error:', err);
      conn.end();
      return;
    }
    stream.on('close', (code, signal) => {
      console.log('Test script written on VPS. Running test script on VPS...');
      
      // Now run the script on the VPS
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node simulate_place_order.js', (err2, stream2) => {
        if (err2) {
          console.error('Exec error:', err2);
          conn.end();
          return;
        }
        let output = '';
        stream2.on('close', (code2, signal2) => {
          console.log('--- VPS TEST RUN OUTPUT START ---');
          console.log(output);
          console.log('--- VPS TEST RUN OUTPUT END ---');
          conn.end();
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          console.error('STDERR:', data.toString());
        });
      });
    }).on('data', (data) => {
      console.log('Write progress:', data.toString());
    });
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);
