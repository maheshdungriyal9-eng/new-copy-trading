const { Client } = require('ssh2');

const config = {
  host: '34.93.162.96',
  port: 22,
  username: 'tradenterinvest',
  password: 'mahesh789',
  readyTimeout: 30000
};

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connection established. Querying /api/logs on VPS...');
  
  // Query localhost:3000/api/logs using curl
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
        console.log(`Retrieved ${logs.length} log entries.`);
        
        // Print the latest 10 log entries with details
        const latest = logs.slice(0, 10);
        latest.forEach((log, idx) => {
          console.log(`\n--- Log Entry ${idx + 1} ---`);
          console.log(`Timestamp: ${log.timestamp}`);
          console.log(`Account: ${log.accountName} (${log.broker})`);
          console.log(`Type: ${log.type}`);
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
