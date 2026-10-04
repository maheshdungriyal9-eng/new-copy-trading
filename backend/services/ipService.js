const axios = require('axios');

let publicIp = '103.55.66.77'; // Fallback default

async function detectPublicIp() {
  try {
    const res = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
    if (res.data && res.data.ip) {
      publicIp = res.data.ip;
      console.log(`[System] Detected server public IP: ${publicIp}`);
    }
  } catch (err) {
    console.error('[System] Failed to detect public IP:', err.message);
  }
  return publicIp;
}

function getPublicIp() {
  return publicIp;
}

module.exports = {
  detectPublicIp,
  getPublicIp
};
