const fs = require('fs');
const content = fs.readFileSync('frontend/app_v6.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, index) => {
  if (line.toLowerCase().includes('depth') && (line.includes('buy') || line.includes('sell') || line.includes('99.') || line.includes('100.'))) {
    console.log(`${index + 1}: ${line.trim()}`);
  }
});
