const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\backend\\server.js';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching server.js for auto-connect:');
lines.forEach((line, idx) => {
  if (line.includes('auto-connect') || line.includes('Failed to auto-connect')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
