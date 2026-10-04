const fs = require('fs');
const path = require('path');

const filepath = './services/motilalService.js';
const content = fs.readFileSync(filepath, 'utf8');

const lines = content.split('\n');
let start = -1;
lines.forEach((line, idx) => {
  if (line.includes('async getOrderBook(')) {
    start = idx;
  }
});

if (start !== -1) {
  console.log(`getOrderBook found at line ${start + 1}`);
  for (let i = start; i < start + 60; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}
