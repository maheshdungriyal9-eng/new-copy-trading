const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'app.js');
if (!fs.existsSync(filePath)) {
  console.error('File not found:', filePath);
  process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for "x-user-id" ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  if (line.includes('x-user-id')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
