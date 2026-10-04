const fs = require('fs');
const content = fs.readFileSync('backend/server.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('loadConfig') || line.includes('config.json') || line.includes('saveConfig')) {
    if (line.length < 150) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  }
});
