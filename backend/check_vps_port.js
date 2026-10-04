const net = require('net');

const client = new net.Socket();
console.log('Attempting to connect to 34.93.162.96:3000...');

client.setTimeout(5000);

client.connect(3000, '34.93.162.96', () => {
  console.log('SUCCESS: Connected to 34.93.162.96:3000 directly!');
  client.destroy();
});

client.on('error', (err) => {
  console.error('FAILED: Connection error:', err.message);
});

client.on('timeout', () => {
  console.error('FAILED: Connection timed out.');
  client.destroy();
});
