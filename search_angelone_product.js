const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'services', 'angelOneService.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for product type in angelOneService.js ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  const lower = line.toLowerCase();
  if (lower.includes('producttype') || lower.includes('margin') || lower.includes('delivery') || lower.includes('carryforward')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
