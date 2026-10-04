const fs = require('fs');
const path = require('path');

const filepath = '../frontend/app_v6.js';
if (!fs.existsSync(filepath)) {
  console.log('Frontend app_v6.js not found!');
  process.exit(0);
}
const content = fs.readFileSync(filepath, 'utf8');

const lines = content.split('\n');
console.log('Searching app_v6.js functions...');
lines.forEach((line, idx) => {
  if (line.includes('function calculatePositionPnl') || line.includes('function getPositionAvgPrice')) {
    console.log(`  Line ${idx + 1}: ${line.trim()}`);
  }
});
