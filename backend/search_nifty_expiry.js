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
const axios = require('./backend/node_modules/axios');
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

async function run() {
  const response = await axios.get(SCRIP_MASTER_URL, { timeout: 30000 });
  const rawData = response.data;
  
  // Filter for NFO Nifty options
  const niftyOptions = rawData.filter(i => i.exch_seg === 'NFO' && i.name === 'NIFTY' && i.instrumenttype === 'OPTIDX');
  console.log("Total NFO NIFTY options:", niftyOptions.length);
  
  // Print unique expiry values in NFO NIFTY options
  const expiries = [...new Set(niftyOptions.map(i => i.expiry))];
  console.log("Unique NIFTY expiries found:", expiries);
  
  // Filter for NIFTY options expiring in Jun 2026
  const jun26Options = niftyOptions.filter(i => i.expiry && i.expiry.includes('JUN2026'));
  console.log("NIFTY options expiring in JUN2026:", jun26Options.length);
  
  if (jun26Options.length > 0) {
    console.log("Sample JUN2026 NIFTY options (first 10):");
    console.log(jun26Options.slice(0, 10).map(i => ({ symbol: i.symbol, expiry: i.expiry, token: i.token })));
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
    const remotePath = '/home/tradenterinvest/app/copy-trading-app/search_nifty_expiry_temp.js';
    const stream = sftp.createWriteStream(remotePath);
    
    stream.on('close', () => {
      console.log('Script written. Running...');
      conn.exec('cd /home/tradenterinvest/app/copy-trading-app/ && node search_nifty_expiry_temp.js', (err2, stream2) => {
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
