const { Client } = require('ssh2');

const config = {
  host: process.env.VPS_SSH_HOST,
  port: 22,
  username: process.env.VPS_SSH_USER,
  password: process.env.VPS_SSH_PASSWORD,
  readyTimeout: 30000
};

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connection established. Querying Dhan logs on VPS...');
  
  conn.exec('curl -s http://localhost:3000/api/logs', (err, stream) => {
    if (err) {
      console.error(err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code, signal) => {
      try {
        const logs = JSON.parse(output);
        const dhanLogs = logs.filter(l => l.broker === 'Dhan' && l.message.includes('Placing order'));
        console.log(`Found ${dhanLogs.length} Dhan order placement log entries.`);
        
        dhanLogs.slice(0, 10).forEach((log, idx) => {
          console.log(`\n--- Dhan Log Entry ${idx + 1} ---`);
          console.log(`Timestamp: ${log.timestamp}`);
          console.log(`Message: ${log.message}`);
          if (log.details) {
            console.log(`Details:`, JSON.stringify(log.details, null, 2));
          }
        });
      } catch (e) {
        console.log('Failed to parse logs JSON, raw output:', output.substring(0, 500));
      }
      conn.end();
    }).on('data', (data) => {
      output += data.toString();
    });
  });
}).on('error', (err) => {
  console.error('Connection error:', err);
}).connect(config);
