const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'app.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for auth/user logic in app.js ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  const lower = line.toLowerCase();
  if (lower.includes('user') || lower.includes('auth') || lower.includes('login') || lower.includes('token')) {
    if (lineNum < 300) {
      console.log(`${lineNum}: ${line.trim()}`);
    }
  }
});
