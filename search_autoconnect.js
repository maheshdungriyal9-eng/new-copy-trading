const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'server.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for auto-connect ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  if (line.includes('auto-connect') || line.includes('autoConnect')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
