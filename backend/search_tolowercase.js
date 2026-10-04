const fs = require('fs');
const path = require('path');

const filepath = '../frontend/app_v6.js';
if (!fs.existsSync(filepath)) {
  console.log('Frontend app_v6.js not found!');
  process.exit(0);
}
const content = fs.readFileSync(filepath, 'utf8');

const lines = content.split('\n');
console.log('Searching toLowerCase in app_v6.js...');
lines.forEach((line, idx) => {
  if (line.includes('toLowerCase')) {
    if (line.length < 200) {
      console.log(`  Line ${idx + 1}: ${line.trim()}`);
    }
  }
});
