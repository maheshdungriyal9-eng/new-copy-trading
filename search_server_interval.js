const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\backend\\server.js';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching server.js for setInterval:');
lines.forEach((line, idx) => {
  if (line.includes('setInterval') && (line.includes('updateCachedWatchlist') || line.includes('Watchlist'))) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
