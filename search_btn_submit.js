const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'app.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for "btn-submit-order" ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  if (line.includes('btn-submit-order')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
