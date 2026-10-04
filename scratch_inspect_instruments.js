const fs = require('fs');
const path = require('path');
const cacheFile = path.join(__dirname, 'backend', 'services', 'angelOneInstruments.json');

if (!fs.existsSync(cacheFile)) {
  console.log('Cache file does not exist locally.');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
console.log('Total instruments cached:', data.length);
console.log('First 10 instruments:');
console.log(JSON.stringify(data.slice(0, 10), null, 2));

console.log('\nSearching for RELIANCE NFO options/futures:');
const relianceNfo = data.filter(item => item.symbol.startsWith('RELIANCE') && item.exchange === 'NFO');
console.log('Found NFO RELIANCE instruments:', relianceNfo.length);
if (relianceNfo.length > 0) {
  console.log('First 10 RELIANCE NFO instruments:');
  console.log(JSON.stringify(relianceNfo.slice(0, 10), null, 2));
}
