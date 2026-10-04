const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'app.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for toast or notification ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  const lower = line.toLowerCase();
  if (lower.includes('toast') || lower.includes('notification') || lower.includes('showmsg') || lower.includes('showalert')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
