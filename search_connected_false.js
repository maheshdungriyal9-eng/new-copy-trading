const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\backend\\services\\angelOneService.js';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching for connected = false or handleApiError in angelOneService.js:');
lines.forEach((line, idx) => {
  if (line.includes('connected = false') || line.includes('handleApiError')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
