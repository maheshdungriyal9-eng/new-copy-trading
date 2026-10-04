const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\dhan_api_v2_documentation.md';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching for JSON examples in Place Order section:');
let inSection = false;
let linesLeft = 0;

lines.forEach((line, idx) => {
  if (line.includes('Place Order') && line.trim().startsWith('##')) {
    inSection = true;
    linesLeft = 100;
  }
  if (inSection && linesLeft > 0) {
    if (line.includes('```json') || line.includes('{') || line.includes('dhanClientId')) {
      console.log(`Line ${idx + 1}: ${line.trim()}`);
      for (let i = idx + 1; i <= idx + 25; i++) {
        console.log(`  ${lines[i - 1]}`);
      }
      inSection = false; // print one match is enough
    }
    linesLeft--;
  }
});
