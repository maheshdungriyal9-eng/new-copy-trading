const fs = require('fs');
const content = fs.readFileSync('frontend/app_v6.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, index) => {
  if (line.includes('stocks/info')) {
    console.log(`${index + 1}: ${line.trim()}`);
  }
});
