const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'services', 'angelOneService.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('--- Matches for handleApiError ---');
lines.forEach((line, idx) => {
  const lineNum = idx + 1;
  if (line.includes('handleApiError')) {
    console.log(`${lineNum}: ${line.trim()}`);
  }
});
