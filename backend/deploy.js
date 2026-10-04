const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

// Run local esbuild minification before uploading
console.log('Bundling and minifying frontend assets using esbuild...');
try {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'frontend', 'app_v6.js')],
    outfile: path.join(__dirname, '..', 'frontend', 'app_v6.min.js'),
    minify: true,
  });
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'frontend', 'style.css')],
    outfile: path.join(__dirname, '..', 'frontend', 'style.min.css'),
    minify: true,
  });
  console.log('Frontend assets minified successfully.');
} catch (e) {
  console.error('Error during esbuild minification:', e.message);
  process.exit(1);
}

const conn = new Client();
const config = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
  readyTimeout: 30000
};

// Map local file paths to their remote target paths
const filesToUpload = [
  {
    local: path.join(__dirname, '..', 'frontend', 'style.min.css'),
    remote: '/home/tradenterinvest/app/copy-trading-app/frontend/style.min.css'
  },
  {
    local: path.join(__dirname, '..', 'frontend', 'index.html'),
    remote: '/home/tradenterinvest/app/copy-trading-app/frontend/index.html'
  },
  {
    local: path.join(__dirname, '..', 'frontend', 'app_v6.min.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/frontend/app_v6.min.js'
  },
  {
    local: path.join(__dirname, 'server.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/server.js'
  },
  {
    local: path.join(__dirname, 'services', 'angelOneService.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/angelOneService.js'
  },
  {
    local: path.join(__dirname, 'services', 'motilalService.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/motilalService.js'
  },
  {
    local: path.join(__dirname, 'services', 'copyTradingEngine.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/copyTradingEngine.js'
  },
  {
    local: path.join(__dirname, 'services', 'tunnelService.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/tunnelService.js'
  },
  {
    local: path.join(__dirname, 'services', 'orderQueueService.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/orderQueueService.js'
  },
  {
    local: path.join(__dirname, 'services', 'dbService.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/dbService.js'
  },
  {
    local: path.join(__dirname, 'services', 'cryptoService.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/cryptoService.js'
  },
  {
    local: path.join(__dirname, 'services', 'unifiedWsClient.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/unifiedWsClient.js'
  },
  {
    local: path.join(__dirname, 'services', 'dhanTradeService.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/dhanTradeService.js'
  },
  {
    local: path.join(__dirname, 'services', 'dhanService.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/dhanService.js'
  },
  {
    local: path.join(__dirname, 'services', 'instrumentService.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/instrumentService.js'
  },
  {
    local: path.join(__dirname, 'services', 'totp.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/totp.js'
  },
  {
    local: path.join(__dirname, 'services', 'stockDb.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/stockDb.js'
  },
  {
    local: path.join(__dirname, 'services', 'foSymbols.json'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/services/foSymbols.json'
  },
  {
    local: path.join(__dirname, 'get_motilal_orders.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/get_motilal_orders.js'
  },
  {
    local: path.join(__dirname, 'test_angel_quote.js'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/test_angel_quote.js'
  },
  {
    local: path.join(__dirname, 'package.json'),
    remote: '/home/tradenterinvest/app/copy-trading-app/backend/package.json'
  }
];

conn.on('ready', () => {
  console.log('SSH connection established. Initializing SFTP...');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err);
      conn.end();
      return;
    }

    let uploadCount = 0;
    
    function uploadNext() {
      if (uploadCount >= filesToUpload.length) {
        console.log('All files uploaded successfully via SFTP.');
        restartPM2();
        return;
      }

      const item = filesToUpload[uploadCount];
      const localPath = item.local;
      const remotePath = item.remote.replace(/\\/g, '/'); // Ensure Linux forward slashes

      console.log(`Uploading ${path.basename(localPath)} to ${remotePath}...`);
      
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) {
          console.error(`Error uploading ${path.basename(localPath)}:`, err);
          conn.end();
          return;
        }
        console.log(`Successfully uploaded ${path.basename(localPath)}.`);
        uploadCount++;
        uploadNext();
      });
    }

    uploadNext();
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);

function restartPM2() {
  console.log('Installing dependencies on VPS and restarting copy-trading app using PM2...');
  conn.exec('npm --prefix /home/tradenterinvest/app/copy-trading-app/backend install && pm2 restart copy-trading', (err, stream) => {
    if (err) {
      console.error('PM2 restart error:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log(`PM2 restart command completed with code ${code}.`);
      console.log(output);
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    }).stderr.on('data', (data) => {
      console.error('STDERR:', data.toString());
    });
  });
}
