const { Client } = require('ssh2');

const sshConfig = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 30000
};

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connection established.');
  
  const scriptCode = `
const axios = require('axios');

async function run() {
  try {
    const res = await axios.get('http://127.0.0.1:3000/api/portfolio/acc_t20y89t');
    const positions = res.data.positions || [];
    console.log('Open positions details:');
    positions.forEach(p => {
      if (p.netqty !== 0) {
        console.log(JSON.stringify(p, null, 2));
      }
    });
  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
`;

  const remotePath = '/home/tradenterinvest/app/copy-trading-app/backend/print_open_positions_vps.js';

  conn.exec(`cat << 'EOF' > ${remotePath}\n${scriptCode}\nEOF\nnode ${remotePath}\nrm -f ${remotePath}`, (err, stream) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', () => {
      console.log('--- VPS OPEN POSITIONS OUTPUT ---');
      console.log(output);
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    });
  });
}).on('error', (err) => {
  console.error(err);
}).connect(sshConfig);
