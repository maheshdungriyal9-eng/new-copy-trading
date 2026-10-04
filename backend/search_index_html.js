const fs = require('fs');
const path = require('path');

const filepath = '../frontend/index.html';
const content = fs.readFileSync(filepath, 'utf8');

const lines = content.split('\n');
console.log('Searching Demat Holdings in index.html...');
lines.forEach((line, idx) => {
  if (line.includes('Demat Holdings') || line.includes('Demat Holdings Portfolio')) {
    console.log(`  Line ${idx + 1}: ${line.trim()}`);
  }
});
