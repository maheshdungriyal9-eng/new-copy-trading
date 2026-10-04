const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\frontend\\app.js';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching app.js for ocPoller:');
lines.forEach((line, idx) => {
  if (line.includes('ocPoller')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
