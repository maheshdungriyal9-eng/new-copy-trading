const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\frontend\\app.js';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching app.js for polling intervals:');
lines.forEach((line, idx) => {
  if (line.includes('setInterval') || line.includes('pollPositions') || line.includes('pollPortfolio') || line.includes('pollOrders')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
