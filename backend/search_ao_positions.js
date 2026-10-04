const fs = require('fs');
const path = require('path');

const filepath = './services/angelOneService.js';
const content = fs.readFileSync(filepath, 'utf8');

const lines = content.split('\n');
let start = -1;
lines.forEach((line, idx) => {
  if (line.includes('async getPosition(')) {
    start = idx;
  }
});

if (start !== -1) {
  console.log(`getPosition found at line ${start + 1}`);
  for (let i = start; i < start + 60; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}
