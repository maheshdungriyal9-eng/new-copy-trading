const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 20000
};

conn.on('ready', () => {
  console.log('SSH ready. Running curl on VPS...');
  conn.exec('curl -s "http://localhost:3000/api/watchlist/prices"', (err, stream) => {
    if (err) {
      console.error('Exec error:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log(`Command exited with code ${code}`);
      try {
        const parsed = JSON.parse(output);
        console.log("Market Open:", parsed.marketOpen);
        console.log("Prices summary:");
        for (const symbol in parsed.prices) {
          console.log(`  ${symbol}: ${parsed.prices[symbol].ltp}`);
        }
      } catch (e) {
        console.log(output);
      }
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    }).stderr.on('data', (data) => {
      console.error('STDERR:', data.toString());
    });
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);
