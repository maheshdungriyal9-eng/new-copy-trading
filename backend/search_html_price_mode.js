const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\frontend\\index.html';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching for setPriceMode in index.html:');
lines.forEach((line, idx) => {
  if (line.includes('setPriceMode') || line.includes('mode-market') || line.includes('mode-limit')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
