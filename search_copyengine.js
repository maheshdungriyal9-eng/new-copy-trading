const fs = require('fs');
const content = fs.readFileSync('backend/server.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('copyEngine') || line.includes('copyTradingEngine')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
