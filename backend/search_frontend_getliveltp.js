const fs = require('fs');

const content = fs.readFileSync('../frontend/app_v6.js', 'utf8');
const lines = content.split('\n');
console.log('Searching getLiveOrStaticLtp in app_v6.js:');
let show = false;
let count = 0;
lines.forEach((line, idx) => {
  if (line.includes('getLiveOrStaticLtp') || line.includes('currentHoldingsData')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
