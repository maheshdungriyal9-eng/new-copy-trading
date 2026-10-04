const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'services', 'angelOneService.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for cache / getHolding / getOrderBook ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  const lower = line.toLowerCase();
  if (lower.includes('cache') || lower.includes('getorderbook') || lower.includes('getholding') || lower.includes('getposition')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
