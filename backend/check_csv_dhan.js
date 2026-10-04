const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, 'api-scrip-master.csv');
const csvData = fs.readFileSync(CSV_PATH, 'utf8');
const lines = csvData.split('\n');

console.log('Searching Dhan CSV...');
const results = [];
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  if (line.includes('NIFTY') && line.includes('24550') && line.includes('CE')) {
    results.push(line);
  }
}

console.log(`Found ${results.length} matching lines:`);
results.slice(0, 10).forEach(r => console.log(r));
