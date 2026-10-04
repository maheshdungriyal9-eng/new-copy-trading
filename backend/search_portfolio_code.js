const fs = require('fs');

const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');
console.log('Searching portfolio/holdings/positions in server.js:');
lines.forEach((line, idx) => {
  if (line.includes('/api/holdings') || line.includes('/api/positions') || line.includes('/api/portfolio') || line.includes('getHolding') || line.includes('getPosition')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
