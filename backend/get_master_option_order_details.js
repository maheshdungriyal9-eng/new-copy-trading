const { Client } = require('ssh2');

const conn = new Client();
const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 30000
};

conn.on('ready', () => {
  console.log('SSH connection established. Searching details...');
  const cmd = `grep -E "job_mgn2zzlub|job_dh7hn6nio|job_6eeq4snxq" /home/tradenterinvest/.pm2/logs/copy-trading-out.log; grep -E "job_mgn2zzlub|job_dh7hn6nio|job_6eeq4snxq" /home/tradenterinvest/.pm2/logs/copy-trading-error.log`;
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      console.log('--- VPS LOGS START ---');
      console.log(output);
      console.log('--- VPS LOGS END ---');
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    }).stderr.on('data', (data) => {
      console.error('STDERR:', data.toString());
    });
  });
}).on('error', (err) => {
  console.error(err);
}).connect(config);
