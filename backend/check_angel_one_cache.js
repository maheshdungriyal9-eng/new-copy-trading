const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 30000
};

const remoteScript = `
const fs = require('fs');
const path = require('path');

const cachePath = './backend/services/angelOneInstruments.json';
if (!fs.existsSync(cachePath)) {
  console.log("Cache file does not exist!");
  process.exit(1);
}

const stats = fs.statSync(cachePath);
console.log("File size:", stats.size, "bytes");
console.log("Last modified:", stats.mtime);

const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
console.log("Total entries in database:", data.length);

const target = 'NIFTY25JUN2624550CE';
const found = data.find(i => i.symbol === target);
console.log("Search for " + target + ":", found ? JSON.stringify(found) : "NOT FOUND");

// Print a few NFO symbols to see what they look like
const nfo = data.filter(i => i.exchange === 'NFO').slice(0, 10);
console.log("\\nSample NFO entries:");
console.log(JSON.stringify(nfo, null, 2));
`;

conn.on('ready', () => {
  console.log('SSH connection established. Writing script...');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    const remotePath = '/home/tradenterinvest/app/copy-trading-app/check_angel_cache_temp.js';
    const stream = sftp.createWriteStream(remotePath);
    
    stream.on('close', () => {
      console.log('Script written. Running...');
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node check_angel_cache_temp.js', (err2, stream2) => {
        if (err2) {
          console.error(err2);
          conn.end();
          return;
        }
        let out = '';
        stream2.on('close', () => {
          console.log('\n--- VPS EXECUTION OUTPUT ---');
          console.log(out);
          sftp.unlink(remotePath, (e) => {
            conn.end();
          });
        }).on('data', (d) => {
          out += d.toString();
        }).stderr.on('data', (d) => {
          console.error('STDERR:', d.toString());
        });
      });
    });
    
    stream.write(remoteScript);
    stream.end();
  });
}).on('error', (err) => {
  console.error(err);
}).connect(config);
