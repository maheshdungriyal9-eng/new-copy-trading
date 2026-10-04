const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\backend\\server.js';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching server.js for updateCachedWatchlist:');
let startLine = -1;
lines.forEach((line, idx) => {
  if (line.includes('async function updateCachedWatchlist')) {
    startLine = idx + 1;
  }
});

if (startLine !== -1) {
  for (let i = startLine - 2; i < startLine + 60; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}
