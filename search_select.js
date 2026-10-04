const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'index.html');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for order-account-select ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  if (line.includes('order-account-select')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
