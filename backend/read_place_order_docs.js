const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\dhan_api_v2_documentation.md';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching for /orders POST endpoint in Dhan docs:');
let count = 0;
lines.forEach((line, idx) => {
  if (line.includes('/v2/orders') || line.includes('POST /v2/orders')) {
    console.log(`--- Match at line ${idx + 1} ---`);
    for (let i = Math.max(1, idx - 5); i <= Math.min(lines.length, idx + 40); i++) {
      console.log(`${i}: ${lines[i - 1]}`);
    }
    console.log('------------------------------');
    count++;
  }
});
