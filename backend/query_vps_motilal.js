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
    const res = await axios.get('http://127.0.0.1:3000/api/portfolio/acc_2rrjf6z');
    console.log('Motilal portfolio response status:', res.status);
    console.log('Motilal portfolio response keys:', Object.keys(res.data));
    console.log('Holdings length:', res.data.holdings ? res.data.holdings.length : 'null');
    console.log('Positions length:', res.data.positions ? res.data.positions.length : 'null');
  } catch (err) {
    console.error('Error fetching Motilal portfolio:');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', JSON.stringify(err.response.data));
    } else {
      console.error(err.message);
    }
  }
}

run();
`;

  const remotePath = '/home/tradenterinvest/app/copy-trading-app/backend/query_vps_motilal_vps.js';

  conn.exec(`cat << 'EOF' > ${remotePath}\n${scriptCode}\nEOF\nnode ${remotePath}\nrm -f ${remotePath}`, (err, stream) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', () => {
      console.log('--- VPS MOTILAL PORTFOLIO OUTPUT ---');
      console.log(output);
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    });
  });
}).on('error', (err) => {
  console.error(err);
}).connect(sshConfig);
