const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'index.html');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for prod- in index.html ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  if (line.includes('prod-') || line.includes('product-btn')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
