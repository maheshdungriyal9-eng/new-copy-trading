const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();
const config = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
  readyTimeout: 30000
};

const scriptPath = path.join(__dirname, 'backend', 'test_vps_search_and_watchlist_fix.js');
const localScriptContent = fs.readFileSync(scriptPath, 'utf8');

conn.on('ready', () => {
  console.log('SSH connection established. Writing test script to VPS...');
  conn.exec(`cat << 'EOF' > /home/tradenterinvest/app/copy-trading-app/backend/test_vps_search_and_watchlist_fix.js\n${localScriptContent}\nEOF`, (err, stream) => {
    if (err) {
      console.error('Exec error:', err);
      conn.end();
      return;
    }
    stream.on('close', (code, signal) => {
      console.log('Test script written. Executing on VPS...');
      
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/backend && node test_vps_search_and_watchlist_fix.js', (err2, stream2) => {
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
