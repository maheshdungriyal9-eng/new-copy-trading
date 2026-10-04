const fs = require('fs');
const path = require('path');

const filePath = 'C:\\Users\\mahes\\.gemini\\antigravity\\scratch\\copy-trading-app\\dhan_api_v2_documentation.md';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Searching for JSON request blocks in Dhan docs:');
let inBlock = false;
let blockLines = [];
let blockStartIdx = 0;

lines.forEach((line, idx) => {
  if (line.trim().startsWith('```json')) {
    inBlock = true;
    blockLines = [];
    blockStartIdx = idx + 1;
  } else if (inBlock && line.trim().startsWith('```')) {
    inBlock = false;
    const blockText = blockLines.join('\n');
    if (blockText.includes('exchangeSegment') && blockText.includes('quantity') && !blockText.includes('orderStatus')) {
      console.log(`--- JSON Block at line ${blockStartIdx} ---`);
      console.log(blockText);
      console.log('-------------------------------------------');
    }
  } else if (inBlock) {
    blockLines.push(line);
  }
});
