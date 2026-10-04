const fs = require('fs');
const content = fs.readFileSync('frontend/index.html', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('master') || line.includes('child') || line.includes('group') || line.includes('mapping')) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
