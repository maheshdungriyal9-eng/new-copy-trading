const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\dhan_api_v2_documentation.md';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching for Place Order section:');
lines.forEach((line, idx) => {
  if (line.toLowerCase().includes('## place order') || line.toLowerCase().includes('### place order') || line.toLowerCase().includes('place-order')) {
    console.log(`--- Match at line ${idx + 1}: ${line.trim()} ---`);
    for (let i = idx; i <= Math.min(lines.length, idx + 40); i++) {
      console.log(`${i}: ${lines[i - 1]}`);
    }
  }
});
