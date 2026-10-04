const fs = require('fs');

const content = fs.readFileSync('services/motilalService.js', 'utf8');
const lines = content.split('\n');
console.log('Searching getHolding in motilalService.js:');
let start = false;
let brackets = 0;
lines.forEach((line, idx) => {
  if (line.includes('async getHolding(')) {
    start = true;
    brackets = 0;
  }
  if (start) {
    console.log(`Line ${idx + 1}: ${line}`);
    // Count opening and closing brackets to know when the method ends
    const openMatches = line.match(/{/g);
    const closeMatches = line.match(/}/g);
    if (openMatches) brackets += openMatches.length;
    if (closeMatches) brackets -= closeMatches.length;
    if (brackets === 0 && idx > 0 && line.includes('}')) {
      start = false;
    }
  }
});
