const fs = require('fs');
const path = require('path');

const filepath = './services/copyTradingEngine.js';
const content = fs.readFileSync(filepath, 'utf8');

const lines = content.split('\n');
console.log('Searching orderStatus in copyTradingEngine.js...');
lines.forEach((line, idx) => {
  if (line.includes('orderStatus')) {
    console.log(`  Line ${idx + 1}: ${line.trim()}`);
  }
});
