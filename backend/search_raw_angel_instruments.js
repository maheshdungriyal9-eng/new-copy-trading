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
const path = require('path');
const axios = require('./backend/node_modules/axios');
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

async function run() {
  console.log("Downloading raw Angel One instrument master...");
  const response = await axios.get(SCRIP_MASTER_URL, { timeout: 30000 });
  const rawData = response.data;
  console.log("Total entries in raw data:", rawData.length);
  
  // Find entries for symbol containing NIFTY25JUN26
  console.log("Searching for NIFTY weekly options...");
  const matches = rawData.filter(i => i.symbol && i.symbol.startsWith('NIFTY25JUN26'));
  console.log("Matches found:", matches.length);
  
  if (matches.length > 0) {
    console.log("First 3 matches:");
    console.log(JSON.stringify(matches.slice(0, 3), null, 2));
  } else {
    // If no matches, find any NIFTY options and print their exch_seg, name, and symbol format
    const nfoNifty = rawData.filter(i => i.exch_seg === 'NFO' && i.symbol && i.symbol.includes('NIFTY') && i.symbol.includes('CE')).slice(0, 5);
    console.log("Sample NFO Nifty options:");
    console.log(JSON.stringify(nfoNifty, null, 2));
  }
}

run().catch(console.error);
`;

conn.on('ready', () => {
  console.log('SSH connection established. Writing script...');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    const remotePath = '/home/tradenterinvest/app/copy-trading-app/search_raw_angel_temp.js';
    const stream = sftp.createWriteStream(remotePath);
    
    stream.on('close', () => {
      console.log('Script written. Running...');
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node search_raw_angel_temp.js', (err2, stream2) => {
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
