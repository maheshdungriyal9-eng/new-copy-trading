const fs = require('fs');

const content = fs.readFileSync('../frontend/app_v6.js', 'utf8');
const lines = content.split('\n');
console.log('Searching hold.profitandloss in app_v6.js:');
lines.forEach((line, idx) => {
  if (line.includes('profitandloss') && (line.includes('hold') || line.includes('h.'))) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
