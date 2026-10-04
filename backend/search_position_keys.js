const fs = require('fs');
const path = require('path');

const services = [
  './services/dhanTradeService.js',
  './services/angelOneService.js',
  './services/motilalService.js'
];

services.forEach(file => {
  const filepath = path.join(__dirname, file);
  if (fs.existsSync(filepath)) {
    const content = fs.readFileSync(filepath, 'utf8');
    console.log(`Searching keys in ${file}...`);
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('realized') || line.includes('realised') || line.includes('unrealized') || line.includes('unrealised')) {
        console.log(`  Line ${idx + 1}: ${line.trim()}`);
      }
    });
  }
});
