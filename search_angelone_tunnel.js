const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'services', 'angelOneService.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for "tunnel" or "ssh" or "vps" ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  const lower = line.toLowerCase();
  if (lower.includes('tunnel') || lower.includes('ssh') || lower.includes('vps')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
