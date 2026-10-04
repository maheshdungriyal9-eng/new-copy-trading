const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'server.js');
if (!fs.existsSync(filePath)) {
  console.error('File not found:', filePath);
  process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for "execute-trade" ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  if (line.includes('execute-trade')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
