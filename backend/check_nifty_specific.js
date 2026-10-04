const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
  readyTimeout: 30000
};

const remoteScript = `
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./backend/services/angelOneInstruments.json', 'utf8'));
const target = 'NIFTY23JUN2624550CE';
const found = data.find(i => i.symbol === target);
console.log("Search for " + target + ":", found ? JSON.stringify(found) : "NOT FOUND");
`;

conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) throw err;
    const remotePath = '/home/tradenterinvest/app/copy-trading-app/check_nifty_spec_temp.js';
    const stream = sftp.createWriteStream(remotePath);
    stream.on('close', () => {
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node check_nifty_spec_temp.js', (err2, stream2) => {
        let out = '';
        stream2.on('close', () => {
          console.log('\n--- VPS EXECUTION OUTPUT ---');
          console.log(out);
          sftp.unlink(remotePath, () => conn.end());
        }).on('data', (d) => {
          out += d.toString();
        });
      });
    });
    stream.write(remoteScript);
    stream.end();
  });
}).connect(config);
