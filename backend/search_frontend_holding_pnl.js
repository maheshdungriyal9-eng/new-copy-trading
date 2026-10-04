const fs = require('fs');

const content = fs.readFileSync('../frontend/app_v6.js', 'utf8');
const lines = content.split('\n');
console.log('Searching holdings rendering in app_v6.js:');
let show = false;
let count = 0;
lines.forEach((line, idx) => {
  if (line.includes('// Render Holdings') || line.includes('function renderHoldings') || line.includes('renderHoldings(')) {
    show = true;
    count = 0;
  }
  if (show) {
    console.log(`Line ${idx + 1}: ${line}`);
    count++;
    if (count > 100) show = false; // print 100 lines max
  }
});
