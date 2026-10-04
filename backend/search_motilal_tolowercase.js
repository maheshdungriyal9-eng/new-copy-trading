const fs = require('fs');
const path = require('path');

const filepath = './services/motilalService.js';
if (!fs.existsSync(filepath)) {
  console.log('Motilal service file not found!');
  process.exit(0);
}
const content = fs.readFileSync(filepath, 'utf8');

const lines = content.split('\n');
console.log('Searching toLowerCase in motilalService.js...');
lines.forEach((line, idx) => {
  if (line.includes('toLowerCase')) {
    console.log(`  Line ${idx + 1}: ${line.trim()}`);
  }
});
