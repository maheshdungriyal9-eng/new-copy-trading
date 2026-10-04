const fs = require('fs');
const path = require('path');

const filepath = './services/angelOneService.js';
const content = fs.readFileSync(filepath, 'utf8');

const lines = content.split('\n');
console.log('Searching handleApiError in angelOneService.js...');
lines.forEach((line, idx) => {
  if (line.includes('handleApiError')) {
    console.log(`  Line ${idx + 1}: ${line.trim()}`);
  }
});
