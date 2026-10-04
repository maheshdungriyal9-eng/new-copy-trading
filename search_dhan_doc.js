const fs = require('fs');
const doc = fs.readFileSync('dhan_api_v2_documentation.md', 'utf8');

const query = 'market';
const lines = doc.split('\n');
let count = 0;

console.log(`Searching for "${query}" in dhan_api_v2_documentation.md...`);

lines.forEach((line, idx) => {
  if (line.toLowerCase().includes(query) && line.toLowerCase().includes('order')) {
    if (count < 40) {
      console.log(`${idx + 1}: ${line.trim()}`);
      count++;
    }
  }
});
