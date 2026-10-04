const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\frontend\\app_v6.js';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching for watchlist click handlers or buy buttons:');
lines.forEach((line, idx) => {
  if (line.includes('renderWatchlistTable') || line.includes('openOrderPlacement') || line.includes('watchlist') && line.includes('click') || line.includes('btn-buy')) {
    if (idx > 3000 && idx < 3300) {
      console.log(`Line ${idx + 1}: ${line.trim()}`);
    }
  }
});
