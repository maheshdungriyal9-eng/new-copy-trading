const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'server.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for "tunnel" ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  if (line.includes('tunnel') || line.includes('Tunnel')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
