const fs = require('fs');
const path = require('path');

const filepath = './server.js';
const content = fs.readFileSync(filepath, 'utf8');

const lines = content.split('\n');
console.log('Searching isLivePrice...');
lines.forEach((line, idx) => {
  if (line.includes('isLivePrice')) {
    console.log(`  Line ${idx + 1}: ${line.trim()}`);
  }
});
