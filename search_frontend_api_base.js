const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'app.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for "API_BASE" ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  if (line.includes('API_BASE')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
