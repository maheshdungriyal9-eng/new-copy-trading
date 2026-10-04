const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyUrl = 'http://copytrader:securepass123@34.180.40.255:3128';

console.log('Testing connection to httpbin.org/ip through new proxy to verify IP routing...');
axios.get('https://httpbin.org/ip', {
  httpsAgent: new HttpsProxyAgent(proxyUrl),
  timeout: 10000
}).then(res => {
  console.log('Success! Response data:', res.data);
}).catch(err => {
  console.error('Failed to connect through proxy:', err.message);
  if (err.response) {
    console.error('Error status:', err.response.status);
    console.error('Error response data:', err.response.data);
  }
});
