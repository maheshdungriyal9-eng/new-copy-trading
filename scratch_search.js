const fs = require('fs');
const path = require('path');
const content = fs.readFileSync(path.join(__dirname, 'backend/services/dhanService.js'), 'utf8');
const lines = content.split('\n');

const terms = ['getdhansymboldetailsbytoken'];

lines.forEach((line, index) => {
  const lineLower = line.toLowerCase();
  const matched = terms.some(term => lineLower.includes(term));
  if (matched) {
    console.log(`--- Line ${index + 1} ---`);
    for (let i = Math.max(0, index - 20); i <= Math.min(lines.length - 1, index + 20); i++) {
      console.log(`${i + 1}: ${lines[i]}`);
    }
  }
});

















