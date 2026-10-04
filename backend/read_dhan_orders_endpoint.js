const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\dhan_api_v2_documentation.md';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching for /v2/orders parameters in Dhan docs:');
let inSection = false;
let linesLeft = 0;

lines.forEach((line, idx) => {
  if (line.includes('POST') && line.includes('/v2/orders') && !line.includes('/slicing') && !line.includes('/forever')) {
    console.log(`--- Match at line ${idx + 1}: ${line.trim()} ---`);
    inSection = true;
    linesLeft = 60;
  }
  if (inSection && linesLeft > 0) {
    console.log(`${idx + 1}: ${line}`);
    linesLeft--;
    if (linesLeft === 0) inSection = false;
  }
});
