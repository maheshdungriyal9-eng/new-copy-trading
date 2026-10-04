const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\backend\\services\\angelOneService.js';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching angelOneService.js for relogin triggers:');
lines.forEach((line, idx) => {
  if (line.includes('disconnected') || line.includes('Access denied') || line.includes('Token or authentication error')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
