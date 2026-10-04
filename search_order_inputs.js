const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'index.html');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for order-qty / order-price ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  if (line.includes('order-qty') || line.includes('order-price')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
