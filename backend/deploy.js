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
for (const name of ['VPS_SSH_HOST', 'VPS_SSH_USER', 'VPS_REMOTE_ROOT']) {
  if (!process.env[name]) throw new Error(name + ' is required');
}
if (!process.env.VPS_SSH_PASSWORD && !process.env.VPS_SSH_KEY_PATH) throw new Error('SSH credentials are required');
const remoteRoot = process.env.VPS_REMOTE_ROOT;
if (!remoteRoot.startsWith('/') || !/^[A-Za-z0-9_./-]+$/.test(remoteRoot) || remoteRoot.includes('..') || remoteRoot === '/') throw new Error('Invalid deployment directory');
const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  privateKey: process.env.VPS_SSH_KEY_PATH ? fs.readFileSync(process.env.VPS_SSH_KEY_PATH) : undefined,
  readyTimeout: 30000
};

// Map local file paths to their remote target paths
const filesToUpload = [
  ...['index.html', 'style.min.css', 'app_v6.min.js', 'relay-mark.svg', 'relay-manrope.woff2', 'relay-spacegrotesk.woff2', 'relay-jetbrainsmono.woff2', 'relay-font-licenses.txt'].map(filename => ({ local: path.join(__dirname, '../frontend', filename), remote: remoteRoot + '/frontend/' + filename })),
  ...['server.js', 'package.json', 'package-lock.json'].map(filename => ({ local: path.join(__dirname, filename), remote: remoteRoot + '/backend/' + filename })),
  ...fs.readdirSync(path.join(__dirname, 'services')).filter(filename => /\.(js|json)$/.test(filename)).map(filename => ({ local: path.join(__dirname, 'services', filename), remote: remoteRoot + '/backend/services/' + filename }))
];
if (!process.argv.includes('--execute')) {
  console.log('Validation only. Runtime files:', filesToUpload.length, 'Use --execute to upload and restart; back up remote data first.');
  process.exit(0);
}

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
          process.exitCode = 1;
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
  process.exitCode = 1;
  console.error('Connection error:', err);
}).connect(config);

function restartPM2() {
  console.log('Installing dependencies on VPS and restarting copy-trading app using PM2...');
  conn.exec('cd ' + remoteRoot + '/backend && node -e "if(Number(process.versions.node.split(\'.\')[0])<22)process.exit(1)" && npm ci --omit=dev --ignore-scripts && pm2 restart copy-trading --update-env', (err, stream) => {
    if (err) {
      console.error('PM2 restart error:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log(`PM2 restart command completed with code ${code}.`);
      if (code !== 0) process.exitCode = 1;
      console.log(output);
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    }).stderr.on('data', (data) => {
      console.error('STDERR:', data.toString());
    });
  });
}
