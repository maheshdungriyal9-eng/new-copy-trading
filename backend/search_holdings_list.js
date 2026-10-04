const fs = require('fs');
const path = require('path');

const filepath = '../frontend/app_v6.js';
const content = fs.readFileSync(filepath, 'utf8');

const lines = content.split('\n');
console.log('Searching portfolio-holdings-list in app_v6.js...');
lines.forEach((line, idx) => {
  if (line.includes('portfolio-holdings-list')) {
    console.log(`  Line ${idx + 1}: ${line.trim()}`);
  }
});
