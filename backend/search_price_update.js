const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../frontend/style.css');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

for (let i = 3309; i < 3330; i++) {
  console.log(`${i + 1}: ${lines[i]}`);
}
