const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\frontend\\app_v6.js';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching for openOrderPlacement definition:');
lines.forEach((line, idx) => {
  if (line.includes('function openOrderPlacement') || line.includes('openOrderPlacement =')) {
    console.log(`--- Match at line ${idx + 1} ---`);
    for (let i = idx; i <= Math.min(lines.length, idx + 60); i++) {
      console.log(`${i}: ${lines[i - 1]}`);
    }
  }
});
