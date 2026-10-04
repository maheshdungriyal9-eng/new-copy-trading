const { Client } = require('ssh2');

const sshConfig = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
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
    const match = positions.find(p => p.tradingsymbol.includes('23950'));
    console.log('Mapped position details for NIFTY 23950 CE:');
    console.log(JSON.stringify(match, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
`;

  const remotePath = '/home/tradenterinvest/app/copy-trading-app/backend/print_mapped_position_vps.js';

  conn.exec(`cat << 'EOF' > ${remotePath}\n${scriptCode}\nEOF\nnode ${remotePath}\nrm -f ${remotePath}`, (err, stream) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', () => {
      console.log('--- VPS MAPPED POSITION OUTPUT ---');
      console.log(output);
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    });
  });
}).on('error', (err) => {
  console.error(err);
}).connect(sshConfig);
